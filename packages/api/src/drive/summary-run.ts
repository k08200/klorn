/**
 * One run of a claimed summary row (step D4 of
 * docs/providers/unified-platform-plan.md), for the job and the on-demand route.
 *
 *   1. The file, through the drive's kill switch: hidden or trashed waits
 *      (`source-unavailable`, PENDING, not an attempt, an hour doubling up to a
 *      day), since a flag can flip back and a file can be restored; a file that
 *      is gone took its summary row with it. SKIPPED is only for what can never
 *      be summarised: a folder, an unsupported or oversized type, no text.
 *   2. Cheap refusals before any byte is read: a folder, a type the extractor
 *      has no text for, a recorded size over the cap, a file or a user whose
 *      daily count is spent.
 *   3. The bytes, capped while they stream (summary-bytes.ts).
 *   4. The text, from the attachment pipeline's extractor (summary-extract.ts).
 *   5. The user's daily count, then the file's, then one model call with a
 *      wall-clock limit (summary-llm.ts, the only LLM-facing module).
 *
 * Outcomes. The claim counted an attempt (summary-store.ts), so a run that never
 * ends spends it. A cap (the daily counts, the LLM layer's cost cap or rate
 * limit) and an outage (no provider answers, a timeout, a retryable storage
 * error) leave the row PENDING with the code and give the attempt back: a cap
 * until it lifts, an outage with a backoff doubling up to a day. Neither ever
 * FAILs. Only a content error (output that is not a summary, a missing object, a
 * run that throws) keeps the attempt, and FAILED follows the last one.
 *
 * Daily slots. The user's and the file's slots are taken just before the call
 * and given back when the call produced nothing billable to Klorn's counts: a
 * refusal (cost cap, rate limit) or an outage. They stay spent once a model
 * answered (DONE, or output that is not a summary). Reserving first and giving
 * back keeps the counts a hard bound on concurrent calls; reserving only after a
 * success would let concurrent runs overshoot them. Money is bounded separately
 * by the LLM layer's cost cap, which pre-bills every call.
 */

import type { DriveSummaryErrorCode } from "@klorn/contract";
import type { CallPriority } from "../billing/quota-limiter.js";
import { captureError } from "../sentry.js";
import { StorageError } from "../storage/errors.js";
import type { DriveProviderEnabledMap } from "./drive-scope.js";
import { type DriveImplementations, driveActionsForProvider } from "./providers/dispatch.js";
import { isDriveUnsupported } from "./providers/types.js";
import { type CappedBytes, readKlornBytesForSummary } from "./summary-bytes.js";
import { extractSummaryText, isSummarisableFile } from "./summary-extract.js";
import { type DriveSummaryResult, summariseDriveText } from "./summary-llm.js";
import {
  DRIVE_SUMMARY_MAX_ATTEMPTS,
  DRIVE_SUMMARY_MAX_SOURCE_BYTES,
  DRIVE_SUMMARY_RATE_LIMITED_DELAY_MS,
  DRIVE_SUMMARY_READABLE_PROVIDERS,
  DRIVE_SUMMARY_RUNS_PER_FILE_PER_DAY,
  nextUtcDay,
  summaryOutageDelayMs,
  summaryRetryDelayMs,
  summarySourceDelayMs,
} from "./summary-policy.js";
import { findSummarySource, type SummarySource } from "./summary-source.js";
import {
  countFileRun,
  fileRunsToday,
  markSummaryAttemptFailed,
  markSummaryDeferred,
  markSummaryDone,
  markSummarySkipped,
  releaseFileRun,
  releaseUserSummary,
  reserveUserSummary,
  type SummaryLease,
  userDailyCountSpent,
} from "./summary-store.js";

/**
 * `waiting`: the file cannot be read for now (a cheap check, like a skip, so it
 * does not use up the job's batch). `lost`: the lease no longer held when the
 * outcome was written, so nothing was.
 */
export type SummaryRunOutcome =
  | "done"
  | "skipped"
  | "waiting"
  | "deferred"
  | "retry"
  | "failed"
  | "lost";

export interface SummaryRunOptions {
  readonly priority: CallPriority;
  readonly now?: Date;
  /** Tests only: the provider flags and connectors the run sees. */
  readonly providerEnabled?: DriveProviderEnabledMap;
  readonly implementations?: DriveImplementations;
}

type ByteRead =
  | CappedBytes
  | { readonly ok: false; readonly reason: DriveSummaryErrorCode | "storage-timeout" };

interface RunContext {
  readonly lease: SummaryLease;
  readonly now: Date;
  readonly options: SummaryRunOptions;
}

const outcome = (written: boolean, ok: SummaryRunOutcome): SummaryRunOutcome =>
  written ? ok : "lost";

async function defer(ctx: RunContext, code: DriveSummaryErrorCode, until: Date) {
  return outcome(await markSummaryDeferred(ctx.lease, code, until), "deferred");
}

/** An outage: PENDING with a backoff that doubles up to a day; never FAILED. */
async function deferOutage(ctx: RunContext, code: DriveSummaryErrorCode) {
  const wait = summaryOutageDelayMs(ctx.lease.row.outageStreak);
  const until = new Date(ctx.now.getTime() + wait);
  return outcome(await markSummaryDeferred(ctx.lease, code, until, { outage: true }), "deferred");
}

/** A file that cannot be read for now: PENDING, not an attempt, a long backoff. */
async function waitForSource(ctx: RunContext) {
  const until = new Date(ctx.now.getTime() + summarySourceDelayMs(ctx.lease.row.outageStreak));
  const written = await markSummaryDeferred(ctx.lease, "source-unavailable", until, {
    outage: true,
  });
  return outcome(written, "waiting");
}

async function skip(ctx: RunContext, code: DriveSummaryErrorCode, etag: string | null) {
  return outcome(await markSummarySkipped(ctx.lease, code, etag), "skipped");
}

/** A content error: the claim's attempt stays spent; FAILED after the last one. */
async function attemptFailed(ctx: RunContext, code: DriveSummaryErrorCode) {
  const giveUp = ctx.lease.row.attempts >= DRIVE_SUMMARY_MAX_ATTEMPTS;
  const retryAt = giveUp
    ? null
    : new Date(ctx.now.getTime() + summaryRetryDelayMs(ctx.lease.row.attempts));
  return outcome(
    await markSummaryAttemptFailed(ctx.lease, code, retryAt),
    giveUp ? "failed" : "retry",
  );
}

/** The file's bytes, capped while they stream: from Klorn's storage, or the connector. */
async function readSourceBytes(ctx: RunContext, source: SummarySource): Promise<ByteRead> {
  const userId = ctx.lease.row.userId;
  if (source.provider === "KLORN") {
    if (source.storageKey === null) return { ok: false, reason: "object-missing" };
    const read = await readKlornBytesForSummary(
      userId,
      source.storageKey,
      DRIVE_SUMMARY_MAX_SOURCE_BYTES,
    );
    if (read.ok) return read;
    // Object storage switched off: the file is hidden too.
    return {
      ok: false,
      reason: read.reason === "storage-unavailable" ? "source-unavailable" : read.reason,
    };
  }
  const actions = driveActionsForProvider(
    source.provider,
    ctx.options.providerEnabled,
    ctx.options.implementations,
  );
  const session = await actions.connect({ userId, sourceKey: source.sourceKey });
  if (session === null || isDriveUnsupported(session)) {
    return { ok: false, reason: "source-unavailable" };
  }
  const fetched = await session.fetchForSummary(source.externalId, {
    maxBytes: DRIVE_SUMMARY_MAX_SOURCE_BYTES,
    mimeType: source.mimeType,
  });
  return fetched ?? { ok: false, reason: "object-missing" };
}

/** A byte read that came back without bytes. */
async function settleUnread(
  ctx: RunContext,
  reason: Extract<ByteRead, { ok: false }>["reason"],
  source: SummarySource,
): Promise<SummaryRunOutcome> {
  // A row without its object: nothing to retry until the file is uploaded again.
  if (reason === "object-missing") {
    return outcome(await markSummaryAttemptFailed(ctx.lease, reason, null), "failed");
  }
  if (reason === "source-unavailable") return await waitForSource(ctx);
  // A read that hung past its deadline is an outage of the store.
  if (reason === "storage-timeout") return await deferOutage(ctx, "storage-error");
  return await skip(ctx, reason, source.etag);
}

/** Give back both daily slots: the call produced nothing billable to the counts. */
async function releaseSlots(ctx: RunContext): Promise<void> {
  await releaseUserSummary(ctx.lease.row.userId, ctx.now);
  await releaseFileRun(ctx.lease, ctx.now);
}

/** The model's answer to the row's next state. */
async function settleResult(
  ctx: RunContext,
  result: DriveSummaryResult,
  source: SummarySource,
): Promise<SummaryRunOutcome> {
  if (result.ok) {
    const { summary, model, costMicroCents } = result;
    const done = { summary, model, costMicroCents, sourceEtag: source.etag };
    return outcome(await markSummaryDone(ctx.lease, done, ctx.now), "done");
  }
  if (result.code === "llm-bad-output" || result.code === "llm-rejected") {
    return await attemptFailed(ctx, result.code);
  }
  await releaseSlots(ctx);
  if (result.code === "cost-cap" || result.code === "daily-limit") {
    return await defer(ctx, result.code, nextUtcDay(ctx.now));
  }
  if (result.code === "rate-limited") {
    const wait = result.retryAfterMs ?? DRIVE_SUMMARY_RATE_LIMITED_DELAY_MS;
    return await defer(ctx, result.code, new Date(ctx.now.getTime() + wait));
  }
  return await deferOutage(ctx, result.code);
}

/** Take both daily slots, or defer: the user's first, then the file's. */
async function takeSlots(ctx: RunContext): Promise<SummaryRunOutcome | null> {
  if (!(await reserveUserSummary(ctx.lease.row.userId, ctx.now))) {
    await releaseUserSummary(ctx.lease.row.userId, ctx.now);
    return await defer(ctx, "daily-limit", nextUtcDay(ctx.now));
  }
  if (!(await countFileRun(ctx.lease, ctx.now))) {
    await releaseUserSummary(ctx.lease.row.userId, ctx.now);
    return await defer(ctx, "file-limit", nextUtcDay(ctx.now));
  }
  return null;
}

/** Steps 3 to 5 for a file that passed the cheap checks. */
async function summariseSource(ctx: RunContext, source: SummarySource): Promise<SummaryRunOutcome> {
  let bytes: ByteRead;
  try {
    bytes = await readSourceBytes(ctx, source);
  } catch (err) {
    if (!(err instanceof StorageError)) throw err;
    return err.retryable
      ? await deferOutage(ctx, "storage-error")
      : await attemptFailed(ctx, "storage-error");
  }
  if (!bytes.ok) return await settleUnread(ctx, bytes.reason, source);
  const text = extractSummaryText(bytes.bytes, source.name, source.mimeType);
  if (!text.ok) return await skip(ctx, text.code, source.etag);

  const refused = await takeSlots(ctx);
  if (refused !== null) return refused;
  const result = await summariseDriveText({
    userId: ctx.lease.row.userId,
    name: source.name,
    mimeType: source.mimeType,
    text: text.text,
    priority: ctx.options.priority,
  });
  return await settleResult(ctx, result, source);
}

/** The checks that need no byte: a refusal's outcome, or null to go on. */
async function cheapRefusal(
  ctx: RunContext,
  source: SummarySource | null,
): Promise<SummaryRunOutcome | null> {
  const { row } = ctx.lease;
  if (source === null) return await waitForSource(ctx);
  // A provider whose bytes Klorn cannot read yet (ONEDRIVE until D6): wait, first.
  if (!DRIVE_SUMMARY_READABLE_PROVIDERS.has(source.provider)) return await waitForSource(ctx);
  if (source.isFolder) return await skip(ctx, "folder", source.etag);
  if (!isSummarisableFile(source.name, source.mimeType, source.sizeBytes)) {
    const tooLarge = source.sizeBytes !== null && source.sizeBytes > DRIVE_SUMMARY_MAX_SOURCE_BYTES;
    return await skip(ctx, tooLarge ? "too-large" : "unsupported-type", source.etag);
  }
  if (fileRunsToday(row, ctx.now) >= DRIVE_SUMMARY_RUNS_PER_FILE_PER_DAY) {
    return await defer(ctx, "file-limit", nextUtcDay(ctx.now));
  }
  if (await userDailyCountSpent(row.userId, ctx.now)) {
    return await defer(ctx, "daily-limit", nextUtcDay(ctx.now));
  }
  return null;
}

/** Run one claimed row to its next state. Throws only when the database does. */
export async function runClaimedSummary(
  lease: SummaryLease,
  options: SummaryRunOptions,
): Promise<SummaryRunOutcome> {
  const ctx: RunContext = { lease, now: options.now ?? new Date(), options };
  const { row } = lease;
  const source = await findSummarySource(row.userId, row.driveFileId, options.providerEnabled);
  const refused = await cheapRefusal(ctx, source);
  if (refused !== null || source === null) return refused ?? "skipped";
  try {
    return await summariseSource(ctx, source);
  } catch (err) {
    captureError(err, { tags: { scope: "drive.summary.run" }, extra: { userId: row.userId } });
    return await attemptFailed(ctx, "internal");
  }
}
