/**
 * One run of a claimed summary row (step D4 of
 * docs/providers/unified-platform-plan.md), for the job and the on-demand route.
 *
 *   1. The file, through the drive's kill switch: hidden or gone waits.
 *   2. Cheap refusals before any byte is read: a folder, a type the extractor
 *      has no text for, a recorded size over the cap, a file whose daily count
 *      is spent.
 *   3. The bytes, capped while they stream (summary-bytes.ts).
 *   4. The text, from the attachment pipeline's extractor (summary-extract.ts).
 *   5. The user's daily count, then the file's, then one model call
 *      (summary-llm.ts, the only LLM-facing module).
 *
 * Outcomes. A cap (the user's or the file's daily count, the LLM layer's cost
 * cap or rate limit) leaves the row PENDING with the reason, due when the cap
 * lifts: never FAILED, and not an attempt. An outage (no provider answers, a
 * storage error, output that is not a summary) is an attempt: PENDING again
 * with backoff, FAILED after DRIVE_SUMMARY_MAX_ATTEMPTS. Nothing here throws to
 * an upload or a listing: neither calls it.
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
import { summariseDriveText } from "./summary-llm.js";
import {
  DRIVE_SUMMARY_MAX_ATTEMPTS,
  DRIVE_SUMMARY_MAX_SOURCE_BYTES,
  DRIVE_SUMMARY_RATE_LIMITED_DELAY_MS,
  DRIVE_SUMMARY_RUNS_PER_FILE_PER_DAY,
  DRIVE_SUMMARY_SOURCE_DELAY_MS,
  nextUtcDay,
  summaryRetryDelayMs,
} from "./summary-policy.js";
import { findSummarySource, type SummarySource } from "./summary-source.js";
import {
  countFileRun,
  fileRunsToday,
  markSummaryAttemptFailed,
  markSummaryDeferred,
  markSummaryDone,
  markSummarySkipped,
  reserveUserSummary,
  type SummaryRow,
} from "./summary-store.js";

export type SummaryRunOutcome = "done" | "skipped" | "deferred" | "retry" | "failed";

export interface SummaryRunOptions {
  readonly priority: CallPriority;
  readonly now?: Date;
  /** Tests only: the provider flags and connectors the run sees. */
  readonly providerEnabled?: DriveProviderEnabledMap;
  readonly implementations?: DriveImplementations;
}

type ByteRead = CappedBytes | { readonly ok: false; readonly reason: DriveSummaryErrorCode };

interface RunContext {
  readonly row: SummaryRow;
  readonly now: Date;
  readonly options: SummaryRunOptions;
}

async function defer(ctx: RunContext, code: DriveSummaryErrorCode, until: Date) {
  await markSummaryDeferred(ctx.row, code, until);
  return "deferred" as const;
}

async function skip(ctx: RunContext, code: DriveSummaryErrorCode, source: SummarySource) {
  await markSummarySkipped(ctx.row, code, source.etag);
  return "skipped" as const;
}

/** A failed attempt: retried with backoff, given up after the last one. */
async function attemptFailed(ctx: RunContext, code: DriveSummaryErrorCode) {
  const attempts = ctx.row.attempts + 1;
  const giveUp = attempts >= DRIVE_SUMMARY_MAX_ATTEMPTS;
  const retryAt = giveUp ? null : new Date(ctx.now.getTime() + summaryRetryDelayMs(attempts));
  await markSummaryAttemptFailed(ctx.row, code, attempts, retryAt);
  return giveUp ? ("failed" as const) : ("retry" as const);
}

/** The file's bytes, capped while they stream: from Klorn's storage, or the connector. */
async function readSourceBytes(ctx: RunContext, source: SummarySource): Promise<ByteRead> {
  if (source.provider === "KLORN") {
    if (source.storageKey === null) return { ok: false, reason: "object-missing" };
    const read = await readKlornBytesForSummary(
      ctx.row.userId,
      source.storageKey,
      DRIVE_SUMMARY_MAX_SOURCE_BYTES,
    );
    if (!read.ok && read.reason === "storage-unavailable") {
      return { ok: false, reason: "source-unavailable" };
    }
    return read;
  }
  const actions = driveActionsForProvider(
    source.provider,
    ctx.options.providerEnabled,
    ctx.options.implementations,
  );
  const session = await actions.connect({ userId: ctx.row.userId, sourceKey: source.sourceKey });
  if (session === null || isDriveUnsupported(session)) {
    return { ok: false, reason: "source-unavailable" };
  }
  const fetched = await session.fetchForSummary(source.externalId, {
    maxBytes: DRIVE_SUMMARY_MAX_SOURCE_BYTES,
  });
  return fetched ?? { ok: false, reason: "object-missing" };
}

/** A byte read that came back without bytes: wait, give up, or skip. */
async function settleUnread(
  ctx: RunContext,
  reason: Extract<ByteRead, { ok: false }>["reason"],
  source: SummarySource,
): Promise<SummaryRunOutcome> {
  if (reason === "source-unavailable") {
    return await defer(ctx, reason, new Date(ctx.now.getTime() + DRIVE_SUMMARY_SOURCE_DELAY_MS));
  }
  if (reason === "object-missing") {
    // A row without its object: nothing to retry until the file is uploaded again.
    await markSummaryAttemptFailed(ctx.row, reason, ctx.row.attempts, null);
    return "failed";
  }
  return await skip(ctx, reason, source);
}

/** The model's answer to the row's next state. */
async function settleResult(
  ctx: RunContext,
  result: Awaited<ReturnType<typeof summariseDriveText>>,
  source: SummarySource,
): Promise<SummaryRunOutcome> {
  if (result.ok) {
    const { summary, model, costMicroCents } = result;
    const done = { summary, model, costMicroCents, sourceEtag: source.etag };
    await markSummaryDone(ctx.row, done, ctx.now);
    return "done";
  }
  if (result.code === "cost-cap" || result.code === "daily-limit") {
    return await defer(ctx, result.code, nextUtcDay(ctx.now));
  }
  if (result.code === "rate-limited") {
    const wait = result.retryAfterMs ?? DRIVE_SUMMARY_RATE_LIMITED_DELAY_MS;
    return await defer(ctx, result.code, new Date(ctx.now.getTime() + wait));
  }
  return await attemptFailed(ctx, result.code);
}

/** Steps 3 to 5 for a file that passed the cheap checks. */
async function summariseSource(ctx: RunContext, source: SummarySource): Promise<SummaryRunOutcome> {
  let bytes: ByteRead;
  try {
    bytes = await readSourceBytes(ctx, source);
  } catch (err) {
    if (!(err instanceof StorageError)) throw err;
    return await attemptFailed(ctx, "storage-error");
  }
  if (!bytes.ok) return await settleUnread(ctx, bytes.reason, source);
  const text = extractSummaryText(bytes.bytes, source.name, source.mimeType);
  if (!text.ok) return await skip(ctx, text.code, source);

  if (!(await reserveUserSummary(ctx.row.userId, ctx.now))) {
    return await defer(ctx, "daily-limit", nextUtcDay(ctx.now));
  }
  if (!(await countFileRun(ctx.row, ctx.now))) {
    return await defer(ctx, "file-limit", nextUtcDay(ctx.now));
  }
  const result = await summariseDriveText({
    userId: ctx.row.userId,
    name: source.name,
    mimeType: source.mimeType,
    text: text.text,
    priority: ctx.options.priority,
  });
  return await settleResult(ctx, result, source);
}

/** Run one claimed row to its next state. Throws only when the database does. */
export async function runClaimedSummary(
  row: SummaryRow,
  options: SummaryRunOptions,
): Promise<SummaryRunOutcome> {
  const ctx: RunContext = { row, now: options.now ?? new Date(), options };
  const source = await findSummarySource(row.userId, row.driveFileId, options.providerEnabled);
  // Hidden (a flag off) or gone (its summary row went with it): look again later.
  if (source === null) {
    return await defer(
      ctx,
      "source-unavailable",
      new Date(ctx.now.getTime() + DRIVE_SUMMARY_SOURCE_DELAY_MS),
    );
  }
  if (source.isFolder) return await skip(ctx, "folder", source);
  if (!isSummarisableFile(source.name, source.mimeType, source.sizeBytes)) {
    const tooLarge = source.sizeBytes !== null && source.sizeBytes > DRIVE_SUMMARY_MAX_SOURCE_BYTES;
    return await skip(ctx, tooLarge ? "too-large" : "unsupported-type", source);
  }
  if (fileRunsToday(row, ctx.now) >= DRIVE_SUMMARY_RUNS_PER_FILE_PER_DAY) {
    return await defer(ctx, "file-limit", nextUtcDay(ctx.now));
  }
  try {
    return await summariseSource(ctx, source);
  } catch (err) {
    captureError(err, { tags: { scope: "drive.summary.run" }, extra: { userId: row.userId } });
    return await attemptFailed(ctx, "internal");
  }
}
