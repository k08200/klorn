/**
 * Uploading to the Klorn drive from /files (D3's web UI step) — the pure
 * rules: the size check made before any request, the multipart body, and the
 * batch of files sent one after another with each one's outcome.
 *
 * POST /api/drive/files reads its fields before its one file part (api
 * routes/klorn-drive.ts refuses a field after the file), so the order below is
 * part of the contract: `size`, then `parentExternalId` when there is one,
 * then `file`. One file per request.
 */

import type { DriveMessageKey } from "./drive-errors";

/** Larger than the cap: refused here, with no request. */
export function uploadSizeErrorKey(size: number, maxFileBytes: number): DriveMessageKey | null {
  return size > maxFileBytes ? "files.drive.error.tooLarge" : null;
}

/** The multipart body of one upload, fields first. */
export function uploadForm(file: File, parentExternalId: string | null): FormData {
  const form = new FormData();
  form.append("size", String(file.size));
  if (parentExternalId !== null) form.append("parentExternalId", parentExternalId);
  form.append("file", file, file.name);
  return form;
}

export type UploadStatus = "waiting" | "uploading" | "done" | "failed";

/**
 * Why a file failed: `precheck`, over the cap and never sent; `sent`, the
 * server refused it; `skipped`, never sent because the batch stopped at an
 * earlier file (its reason is that file's).
 */
export type UploadCause = "precheck" | "sent" | "skipped";

export interface UploadItem {
  /** Stable within the batch: two files may share a name. */
  key: string;
  name: string;
  status: UploadStatus;
  errorKey: DriveMessageKey | null;
  cause: UploadCause | null;
}

export interface UploadBatch {
  items: readonly UploadItem[];
}

/** The picked files, each over the cap already failed (no request for it). */
export function startBatch(
  files: readonly { name: string; size: number }[],
  maxFileBytes: number,
): UploadBatch {
  return {
    items: files.map(({ name, size }, index) => {
      const tooLarge = uploadSizeErrorKey(size, maxFileBytes);
      return {
        key: `${index}:${name}`,
        name,
        status: tooLarge ? "failed" : "waiting",
        errorKey: tooLarge,
        cause: tooLarge ? "precheck" : null,
      };
    }),
  };
}

function withItem(
  batch: UploadBatch,
  index: number,
  change: Pick<UploadItem, "status" | "errorKey" | "cause">,
): UploadBatch {
  return {
    items: batch.items.map((item, at) => (at === index ? { ...item, ...change } : item)),
  };
}

export function markUploading(batch: UploadBatch, index: number): UploadBatch {
  return withItem(batch, index, { status: "uploading", errorKey: null, cause: null });
}

export function markDone(batch: UploadBatch, index: number): UploadBatch {
  return withItem(batch, index, { status: "done", errorKey: null, cause: null });
}

export function markFailed(batch: UploadBatch, index: number, key: DriveMessageKey): UploadBatch {
  return withItem(batch, index, { status: "failed", errorKey: key, cause: "sent" });
}

/** Every file from `from` on that has not been sent: skipped, with the batch's reason. */
export function failRemaining(batch: UploadBatch, from: number, key: DriveMessageKey): UploadBatch {
  return {
    items: batch.items.map((item, at) =>
      at >= from && item.status === "waiting"
        ? { ...item, status: "failed", errorKey: key, cause: "skipped" }
        : item,
    ),
  };
}

const indicesWhere = (batch: UploadBatch, keep: (item: UploadItem) => boolean): number[] =>
  batch.items.flatMap((item, index) => (keep(item) ? [index] : []));

/** The files still to send, in order. */
export function pendingIndices(batch: UploadBatch): number[] {
  return indicesWhere(batch, (item) => item.status === "waiting");
}

/** The names the size check refused, announced together once. */
export function precheckFailures(batch: UploadBatch): string[] {
  return batch.items.filter((item) => item.cause === "precheck").map((item) => item.name);
}

/** Refusals that may pass on a second try: a limit, the network, the server's side. */
const RETRYABLE: ReadonlySet<DriveMessageKey> = new Set<DriveMessageKey>([
  "files.drive.error.rateLimited",
  "files.drive.error.offline",
  "files.drive.error.storage",
  "files.drive.error.generic",
  "files.drive.error.malformed",
  "files.drive.error.invalidUpload",
]);

/** "Retry failed": every skipped file, and every refusal that may pass now. */
export function retryableIndices(batch: UploadBatch): number[] {
  return indicesWhere(
    batch,
    (item) =>
      item.status === "failed" &&
      (item.cause === "skipped" ||
        (item.cause === "sent" && item.errorKey !== null && RETRYABLE.has(item.errorKey))),
  );
}

/** Those files waiting again, nothing else changed. */
export function resetForRetry(batch: UploadBatch, indices: readonly number[]): UploadBatch {
  const again = new Set(indices);
  return {
    items: batch.items.map((item, at) =>
      again.has(at) ? { ...item, status: "waiting", errorKey: null, cause: null } : item,
    ),
  };
}

/**
 * "Cancel": the file in flight and every one still waiting become skipped,
 * as cancelled, so "Retry failed" can send them. Files already answered keep
 * their outcome.
 */
export function cancelBatch(batch: UploadBatch): UploadBatch {
  return {
    items: batch.items.map((item) =>
      item.status === "waiting" || item.status === "uploading"
        ? { ...item, status: "failed", errorKey: "files.drive.error.cancelled", cause: "skipped" }
        : item,
    ),
  };
}

export interface BatchSummary {
  total: number;
  /** 1-based position of the file being sent; null when none is. */
  current: number | null;
  done: number;
  failed: number;
  finished: boolean;
}

export function batchSummary(batch: UploadBatch): BatchSummary {
  const at = batch.items.findIndex((item) => item.status === "uploading");
  const done = batch.items.filter((item) => item.status === "done").length;
  const failed = batch.items.filter((item) => item.status === "failed").length;
  return {
    total: batch.items.length,
    current: at === -1 ? null : at + 1,
    done,
    failed,
    finished: done + failed === batch.items.length,
  };
}

/**
 * Refusals every later file of the batch would get too: the batch stops and
 * the rest are skipped with the same reason instead of each costing a
 * request (and, for the rate limit, making the wait longer). A 401 is among
 * them: apiFetch has ended the session, so nothing more may be sent.
 */
const STOPS_BATCH: ReadonlySet<DriveMessageKey> = new Set<DriveMessageKey>([
  "files.drive.error.rateLimited",
  "files.drive.error.full",
  "files.drive.error.notConfigured",
  "files.drive.error.purging",
  "files.drive.error.parentNotFound",
  "files.drive.error.storage",
  "files.drive.error.unavailable",
  "files.drive.error.offline",
  "files.drive.error.signedOut",
]);

export function stopsBatch(key: DriveMessageKey): boolean {
  return STOPS_BATCH.has(key);
}

/**
 * The toast for a batch that ended after the person left /files (an in-app
 * navigation does not stop it). The batch's list does not survive the page,
 * so the message says where to upload what did not go.
 */
export function backgroundResult(batch: UploadBatch): {
  key: "files.drive.upload.backgroundAll" | "files.drive.upload.backgroundSome";
  vars: Record<string, string>;
  failed: boolean;
} {
  const { done, failed } = batchSummary(batch);
  return failed === 0
    ? { key: "files.drive.upload.backgroundAll", vars: { done: String(done) }, failed: false }
    : {
        key: "files.drive.upload.backgroundSome",
        vars: { done: String(done), failed: String(failed) },
        failed: true,
      };
}
