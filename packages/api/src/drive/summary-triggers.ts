/**
 * What starts a summary (step D4 of docs/providers/unified-platform-plan.md):
 *
 *   - a write of a file's row (D3's upload today; D5 and D6 syncs later, after
 *     each `upsertDriveFileRow`): `enqueueSummaryOnWrite` queues it at its etag,
 *     and queues it again only when the etag differs. It never throws: a summary
 *     must not fail an upload or a sync;
 *   - a user asking (`POST /api/drive/files/:id/summarize`): `requestDriveSummary`
 *     queues it, runs it now when it is due, and answers its state.
 *
 * Both do nothing while summaries are off (`driveSummariesLive`, read per call);
 * the route is dark then anyway. The run (and with it the LLM layer) is loaded
 * only when a request runs one, so the upload path that queues does not load it.
 */

import type { DriveFileSummaryWire } from "@klorn/contract";
import { captureError } from "../sentry.js";
import { DRIVE_PROVIDER_ENABLED, type DriveProviderEnabledMap } from "./drive-scope.js";
import { driveSummariesLive } from "./summary-policy.js";
import { findSummarySource } from "./summary-source.js";
import {
  claimSummary,
  enqueueDriveFileSummary,
  findSummaryRow,
  toDriveSummaryWire,
} from "./summary-store.js";

/** Queue the summary of a file whose row was just written. Never throws. */
export async function enqueueSummaryOnWrite(
  userId: string,
  driveFileId: string,
  etag: string | null,
): Promise<void> {
  if (!driveSummariesLive()) return;
  try {
    await enqueueDriveFileSummary(userId, driveFileId, etag);
  } catch (err) {
    console.error(`[DRIVE] could not queue a file summary for user ${userId}`);
    captureError(err, { tags: { scope: "drive.summary.enqueue" }, extra: { userId } });
  }
}

/** The summary of the user's file for the wire, or null when it has none. */
export async function summaryForFile(
  userId: string,
  driveFileId: string,
): Promise<DriveFileSummaryWire | null> {
  const row = await findSummaryRow(userId, driveFileId);
  return row === null ? null : toDriveSummaryWire(row);
}

/**
 * Summarise the user's file now if it is due (new, changed, or FAILED, which
 * this retries), and answer its state. Null when the file is not the user's,
 * not visible or gone: the route's 404. A cap still holds: a deferred summary
 * stays PENDING with its reason.
 */
export async function requestDriveSummary(
  userId: string,
  id: string,
  options: { readonly now?: Date; readonly providerEnabled?: DriveProviderEnabledMap } = {},
): Promise<DriveFileSummaryWire | null> {
  const providerEnabled = options.providerEnabled ?? DRIVE_PROVIDER_ENABLED;
  const source = await findSummarySource(userId, id, providerEnabled);
  if (source === null) return null;
  const now = options.now ?? new Date();
  const row = await enqueueDriveFileSummary(
    userId,
    source.id,
    source.etag,
    { retryFailed: true },
    now,
  );
  const lease = row.status === "PENDING" ? await claimSummary(row, now) : null;
  if (lease !== null) {
    const { runClaimedSummary } = await import("./summary-run.js");
    await runClaimedSummary(lease, { priority: "foreground", now, providerEnabled });
  }
  return await summaryForFile(userId, source.id);
}
