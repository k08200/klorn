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

export interface UploadItem {
  /** Stable within the batch: two files may share a name. */
  key: string;
  name: string;
  status: UploadStatus;
  errorKey: DriveMessageKey | null;
  /** Failed without being sent: the batch stopped at an earlier file. */
  skipped: boolean;
}

export interface UploadBatch {
  items: readonly UploadItem[];
}

export function startBatch(names: readonly string[]): UploadBatch {
  return {
    items: names.map((name, index) => ({
      key: `${index}:${name}`,
      name,
      status: "waiting",
      errorKey: null,
      skipped: false,
    })),
  };
}

function withItem(
  batch: UploadBatch,
  index: number,
  change: Pick<UploadItem, "status" | "errorKey">,
): UploadBatch {
  return {
    items: batch.items.map((item, at) => (at === index ? { ...item, ...change } : item)),
  };
}

export function markUploading(batch: UploadBatch, index: number): UploadBatch {
  return withItem(batch, index, { status: "uploading", errorKey: null });
}

export function markDone(batch: UploadBatch, index: number): UploadBatch {
  return withItem(batch, index, { status: "done", errorKey: null });
}

export function markFailed(batch: UploadBatch, index: number, key: DriveMessageKey): UploadBatch {
  return withItem(batch, index, { status: "failed", errorKey: key });
}

/** Every file from `from` on that has not been sent, failed with the batch's reason. */
export function failRemaining(batch: UploadBatch, from: number, key: DriveMessageKey): UploadBatch {
  return {
    items: batch.items.map((item, at) =>
      at >= from && item.status === "waiting"
        ? { ...item, status: "failed", errorKey: key, skipped: true }
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
 * the rest fail with the same reason instead of each costing a request (and,
 * for the rate limit, making the wait longer).
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
]);

export function stopsBatch(key: DriveMessageKey): boolean {
  return STOPS_BATCH.has(key);
}
