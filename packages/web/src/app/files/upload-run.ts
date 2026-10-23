/**
 * The upload run (D3's web UI step): the given files of a batch, one request
 * after another. A refusal about one file (a bad name, a server fault) fails
 * that file and the run goes on; a refusal every later file would get too
 * (`stopsBatch`: the rate limit, a full drive, a 401, the network, …) skips
 * the rest with its reason. The request, the reading of a failure and its
 * reporting are passed in, so the run itself has no React and no network.
 */

import type { DriveMessageKey } from "./drive-errors";
import {
  failRemaining,
  markDone,
  markFailed,
  markUploading,
  stopsBatch,
  type UploadBatch,
} from "./upload-model";

export interface UploadDeps {
  upload: (file: File, parentExternalId: string | null, signal?: AbortSignal) => Promise<unknown>;
  classify: (err: unknown) => DriveMessageKey;
  /** Sees every failure with its key; decides itself what is worth reporting. */
  report: (err: unknown, key: DriveMessageKey) => void;
}

export type BatchStep = (update: (batch: UploadBatch) => UploadBatch) => void;

/**
 * Sends `files[index]` for each index, in order, into `parentExternalId`.
 * `signal` aborts the file in flight when the page goes away: the run then
 * stops at once, and the abort is nobody's news (nothing is reported).
 */
export async function runUploads(
  files: readonly File[],
  indices: readonly number[],
  parentExternalId: string | null,
  deps: UploadDeps,
  step: BatchStep,
  signal?: AbortSignal,
): Promise<void> {
  for (const index of indices) {
    const file = files[index];
    if (file === undefined) continue;
    if (signal?.aborted) return;
    step((batch) => markUploading(batch, index));
    try {
      await deps.upload(file, parentExternalId, signal);
      step((batch) => markDone(batch, index));
    } catch (err) {
      if (signal?.aborted) return;
      const key = deps.classify(err);
      deps.report(err, key);
      step((batch) => markFailed(batch, index, key));
      if (stopsBatch(key)) {
        step((batch) => failRemaining(batch, index + 1, key));
        return;
      }
    }
  }
}
