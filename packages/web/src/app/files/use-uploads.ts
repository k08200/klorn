"use client";

/**
 * Uploading picked files into the open Klorn drive folder, one after another
 * (one file per request, D3). Each file's size is checked first: a file over
 * the cap fails here without a request. A refusal every later file would get
 * too (the rate limit, a full drive, …) stops the batch. The list and the
 * usage are read again once, when the batch ends, not after every file.
 */

import { useRef, useState } from "react";
import type { DriveMessageKey } from "./drive-errors";
import {
  batchSummary,
  failRemaining,
  markDone,
  markFailed,
  markUploading,
  startBatch,
  stopsBatch,
  type UploadBatch,
  uploadSizeErrorKey,
} from "./upload-model";
import { reportDriveError, uploadDriveFile } from "./use-klorn-drive";

interface UploadsOptions {
  /** The folder the files go into; null for the drive's top level. */
  parentExternalId: string | null;
  maxFileBytes: number;
  onFinished: () => Promise<void>;
}

type Step = (update: (batch: UploadBatch) => UploadBatch) => void;

/** Sends one file; the reason it failed, or null. */
async function sendOne(
  file: File,
  options: UploadsOptions,
  index: number,
  step: Step,
): Promise<DriveMessageKey | null> {
  const tooLarge = uploadSizeErrorKey(file.size, options.maxFileBytes);
  if (tooLarge !== null) {
    step((batch) => markFailed(batch, index, tooLarge));
    return tooLarge;
  }
  step((batch) => markUploading(batch, index));
  try {
    await uploadDriveFile(file, options.parentExternalId);
    step((batch) => markDone(batch, index));
    return null;
  } catch (err) {
    const key = reportDriveError(err, "files.drive.upload");
    step((batch) => markFailed(batch, index, key));
    return key;
  }
}

async function sendAll(files: readonly File[], options: UploadsOptions, step: Step) {
  for (const [index, file] of files.entries()) {
    const failure = await sendOne(file, options, index, step);
    if (failure !== null && stopsBatch(failure)) {
      step((batch) => failRemaining(batch, index + 1, failure));
      return;
    }
  }
}

export function useUploads(options: UploadsOptions) {
  const [batch, setBatch] = useState<UploadBatch | null>(null);
  const running = useRef(false);
  const step: Step = (update) => setBatch((current) => (current ? update(current) : current));

  const start = async (files: readonly File[]) => {
    // One batch at a time: a second pick while one runs is ignored.
    if (running.current || files.length === 0) return;
    running.current = true;
    setBatch(startBatch(files.map((file) => file.name)));
    try {
      await sendAll(files, options, step);
    } finally {
      running.current = false;
      await options.onFinished().catch((err: unknown) => {
        reportDriveError(err, "files.drive.refresh");
      });
    }
  };

  return {
    batch,
    running: batch !== null && !batchSummary(batch).finished,
    start: (files: readonly File[]) => void start(files),
    /** Drops a finished batch's list. */
    clear: () => setBatch(null),
  };
}
