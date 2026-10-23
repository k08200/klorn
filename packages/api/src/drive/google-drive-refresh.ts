/**
 * One Google Drive account's metadata refresh (step D5d of
 * docs/providers/unified-platform-plan.md, D5 "Refresh"), for the hourly job
 * (google-drive-refresh-job.ts). Picked files only: one `files.get` per indexed
 * row, with D5c's fields mask (providers/google-files.ts), on the account's own
 * OAuth client, at most GOOGLE_REFRESH_IN_FLIGHT at once.
 *
 * Google's answer for a row:
 *   - the file: its row brought up to date through the writer's update-only call
 *     (drive-rows.ts `updateDriveFileRow`, so a row an unlink removed meanwhile
 *     is never brought back), `trashed` included. Its summary is queued again
 *     only when the etag moved (summary-triggers.ts): an unchanged file writes
 *     nothing to the summary table, and a trashed one is not queued;
 *   - a 404: that row is deleted through the writer's per-file delete
 *     (`deleteConnectedDriveRows`). A transient 404 deletes a row too (the plan's
 *     Risks; a re-pick brings it back);
 *   - a 403 about the file (picked under another app, or no longer the user's to
 *     read): the row is left as it is;
 *   - any other refusal of that one call (a 400, a 403 that is neither about the
 *     file, a rate limit nor the project): the row is left as it is, logged and
 *     reported once per pass by status and reason, and the pass goes on, so one
 *     bad row cannot hold its account back for good;
 *   - a revoked grant: the account is flagged for reconnect (google-auth.ts), and
 *     the pass ends; its rows stay until the user unlinks; the sweep goes on;
 *   - a 429, a rate-limit 403, a 5xx, no answer or a timeout (`stopped`), or a
 *     403 about the whole Cloud project, the Drive API off (`blocked`, reported
 *     at most once an hour per process): the pass ends, and so does the sweep
 *     (google-drive-refresh-job.ts), so a retry never fans out over 20 accounts.
 * A pass that ends starts no further call for that account, and does not stamp
 * it: only a pass through every row sets `lastRefreshedAt`.
 *
 * The account is loaded by (id, userId, provider) first, every time; a flagged
 * account is not decrypted. The flags are read again here, so a pass that
 * starts after they went off reads and writes nothing. Logging names an HTTP
 * status and Google's reason, never a googleapis error: it carries its
 * request's Authorization header.
 */

import { captureError } from "../sentry.js";
import { type ConnectedAccountFile, connectedAccountFiles } from "./drive-read.js";
import {
  connectedDriveSource,
  type DriveFileInput,
  deleteConnectedDriveRows,
  updateDriveFileRow,
} from "./drive-rows.js";
import { driveProvidersFor, googleDriveRoutesEnabled } from "./drive-scope.js";
import { GOOGLE_DRIVE_ROWS_PER_ACCOUNT } from "./google-drive-picker.js";
import { loadDriveAccountCredentials, markDriveAccountRefreshed } from "./linked-drive-accounts.js";
import { googleDriveSession } from "./providers/google.js";
import { buildLinkedDriveClient, handleDriveGrantFailure } from "./providers/google-auth.js";
import {
  googleFailureLabel,
  isGoogleFileForbidden,
  isGoogleProjectBlocked,
  isGoogleRetryable,
} from "./providers/google-files.js";
import type { DriveProviderSession, ProviderDriveFile } from "./providers/types.js";
import { enqueueSummaryOnWrite } from "./summary-triggers.js";

/** files.get calls in flight for one account (plan, D5 "Refresh"). */
export const GOOGLE_REFRESH_IN_FLIGHT = 4;
/**
 * The most rows one pass reads. The per-account cap (500) is soft by a few
 * concurrent picks' worth (google-drive-picker.ts), so twice it bounds a pass
 * whatever happened, and reaches every row in practice.
 */
const REFRESH_ROWS_PER_PASS = 2 * GOOGLE_DRIVE_ROWS_PER_ACCOUNT;
/** A project-wide refusal is reported at most this often per process, not per account. */
const BLOCKED_REPORT_EVERY_MS = 60 * 60_000;

/**
 * `refreshed`: every row was read (or skipped as unreadable), the account is
 * stamped. `stopped`: a rate limit or an outage ended the pass, and ends the
 * sweep. `blocked`: Google refuses the whole project; it ends the sweep too.
 * `needs-reconnect`: the grant is revoked, the account is flagged. `skipped`:
 * nothing was read (the flags are off, the account is not this user's, flagged,
 * or undecryptable).
 */
export type AccountRefreshOutcome =
  | "refreshed"
  | "stopped"
  | "blocked"
  | "needs-reconnect"
  | "skipped";

/** A row's verdict for the pass: go on, or end it (and why). */
type RowOutcome = "go" | "stop" | "blocked" | "revoked";

interface PassContext {
  readonly userId: string;
  readonly accountId: string;
  readonly session: DriveProviderSession;
  /** The labels of the refusals this pass already logged and reported. */
  readonly reported: Set<string>;
}

let blockedReportedAt: number | null = null;

/** Tests only: forget when the project-wide refusal was last reported. */
export function resetRefreshReportsForTests(): void {
  blockedReportedAt = null;
}

/** Google refuses the project: say so at most once an hour per process. */
function reportBlocked(label: string): void {
  const now = Date.now();
  if (blockedReportedAt !== null && now - blockedReportedAt < BLOCKED_REPORT_EVERY_MS) return;
  blockedReportedAt = now;
  console.error(`[GOOGLE-DRIVE] refresh blocked for the whole project: ${label}`);
  captureError(new Error(`Google Drive refresh blocked: ${label}`), {
    tags: { scope: "drive.google.refresh.blocked" },
  });
}

/** One row Google refused for itself: logged and reported once per pass and label. */
function reportSkipped(ctx: PassContext, label: string): void {
  if (ctx.reported.has(label)) return;
  ctx.reported.add(label);
  console.warn(`[GOOGLE-DRIVE] refresh of drive account ${ctx.accountId} skipped a file: ${label}`);
  // A new Error, never the googleapis error: its request config holds the bearer token.
  captureError(new Error(`Google Drive refresh skipped a file: ${label}`), {
    tags: { scope: "drive.google.refresh" },
    extra: { userId: ctx.userId, accountId: ctx.accountId },
  });
}

/** The row's fields, all from Google's answer. The identity and isFolder are never touched. */
function rowInput(file: ProviderDriveFile): DriveFileInput {
  return {
    name: file.name,
    modifiedAt: file.modifiedAt,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    parentExternalId: file.parentExternalId,
    webUrl: file.webUrl,
    etag: file.etag,
    trashed: file.trashed,
  };
}

/** A failed files.get: the pass goes on past a refusal of this one file, or ends. */
async function settleFailure(ctx: PassContext, err: unknown): Promise<RowOutcome> {
  if (await handleDriveGrantFailure(ctx.userId, ctx.accountId, err)) return "revoked";
  if (isGoogleFileForbidden(err)) return "go";
  const label = googleFailureLabel(err);
  // A rate limit or an outage is expected now and then: no report, the account is due again.
  if (isGoogleRetryable(err)) {
    console.warn(`[GOOGLE-DRIVE] refresh of drive account ${ctx.accountId} ended: ${label}`);
    return "stop";
  }
  if (isGoogleProjectBlocked(err)) {
    reportBlocked(label);
    return "blocked";
  }
  reportSkipped(ctx, label);
  return "go";
}

/** Write what Google said of this row's file, and queue its summary when the etag moved. */
async function writeRow(
  ctx: PassContext,
  row: ConnectedAccountFile,
  file: ProviderDriveFile,
): Promise<void> {
  // An answer for another id is not this row's: nothing of it is written.
  if (file.externalId !== row.externalId) return;
  const source = connectedDriveSource("GOOGLE", ctx.accountId, row.externalId);
  const written = await updateDriveFileRow(ctx.userId, source, rowInput(file));
  if (!written.ok || !written.updated) return;
  if (!file.trashed && file.etag !== row.etag) {
    await enqueueSummaryOnWrite(ctx.userId, row.id, file.etag);
  }
}

async function refreshRow(ctx: PassContext, row: ConnectedAccountFile): Promise<RowOutcome> {
  let file: ProviderDriveFile | null;
  try {
    file = await ctx.session.getMetadata(row.externalId);
  } catch (err) {
    return await settleFailure(ctx, err);
  }
  if (file === null) {
    await deleteConnectedDriveRows(ctx.userId, "GOOGLE", ctx.accountId, [row.externalId]);
    return "go";
  }
  await writeRow(ctx, row, file);
  return "go";
}

/**
 * Run `work` over the rows, `limit` at once. The first row that ends the pass
 * stops any further row from starting (the ones in flight finish); a throw (the
 * database) does the same, and is rethrown once they have.
 */
async function eachInFlight(
  rows: readonly ConnectedAccountFile[],
  limit: number,
  work: (row: ConnectedAccountFile) => Promise<RowOutcome>,
): Promise<RowOutcome> {
  let next = 0;
  let ended: RowOutcome = "go";
  const thrown: unknown[] = [];
  const worker = async (): Promise<void> => {
    while (ended === "go" && thrown.length === 0 && next < rows.length) {
      const row = rows[next] as ConnectedAccountFile;
      next += 1;
      try {
        const outcome = await work(row);
        if (ended === "go") ended = outcome;
      } catch (err) {
        thrown.push(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, worker));
  if (thrown.length > 0) throw thrown[0];
  return ended;
}

/** Refresh one of the user's own Google accounts; `now` is what its stamp says. */
export async function refreshGoogleDriveAccount(
  userId: string,
  accountId: string,
  now: Date,
): Promise<AccountRefreshOutcome> {
  if (!googleDriveRoutesEnabled(driveProvidersFor(userId))) return "skipped";
  const account = await loadDriveAccountCredentials(userId, "GOOGLE", accountId);
  // A flagged account stays flagged until a re-link: its grant is not decrypted.
  if (account === null || account.needsReconnect) return "skipped";
  // Null when the grant cannot be decrypted; that flags the account itself.
  const linked = buildLinkedDriveClient(userId, account);
  if (linked === null) return "skipped";
  const rows = await connectedAccountFiles(
    userId,
    { provider: "GOOGLE", sourceKey: account.id },
    { take: REFRESH_ROWS_PER_PASS },
  );
  const ctx: PassContext = {
    userId,
    accountId: account.id,
    session: googleDriveSession(linked),
    reported: new Set(),
  };
  const ended = await eachInFlight(rows, GOOGLE_REFRESH_IN_FLIGHT, (row) => refreshRow(ctx, row));
  if (ended === "revoked") return "needs-reconnect";
  if (ended === "stop") return "stopped";
  if (ended === "blocked") return "blocked";
  await markDriveAccountRefreshed(userId, account.id, now);
  return "refreshed";
}
