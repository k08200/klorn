"use client";

/**
 * Uploading picked files into the open Klorn drive folder, one after another
 * (one file per request, D3; the run itself is upload-run.ts). Files over the
 * cap fail before any request. "Retry failed" sends again the files that may
 * pass now (the rate limit, the network, a server fault, the skipped ones),
 * into the folder the batch was started in. The list and the usage are read
 * again once each run ends, not after every file. There is no per-file
 * deadline (a 25 MiB file can rightly be slow); leaving the page while a
 * batch runs asks first, and unmounting aborts the file in flight.
 */

import { useEffect, useRef, useState } from "react";
import { captureClientError } from "../../lib/sentry";
import { driveErrorKey, isUnexpectedDriveError } from "./drive-errors";
import type { FolderCrumb } from "./open";
import {
  batchSummary,
  pendingIndices,
  resetForRetry,
  retryableIndices,
  startBatch,
  type UploadBatch,
} from "./upload-model";
import { type BatchStep, runUploads, type UploadDeps } from "./upload-run";
import { uploadDriveFile } from "./use-klorn-drive";

const DEPS: UploadDeps = {
  upload: uploadDriveFile,
  classify: driveErrorKey,
  report: (err, key) => {
    if (isUnexpectedDriveError(key)) captureClientError(err, { scope: "files.drive.upload" });
  },
};

interface UploadsOptions {
  /** The folder new files go into; null for the drive's top level. */
  folder: FolderCrumb | null;
  maxFileBytes: number;
  onFinished: () => Promise<void>;
}

/** What became of a pick or a drop: sent, refused because a run is going, or nothing picked. */
export type StartResult = "started" | "busy" | "empty";

/** While a batch runs, leaving the page asks first (the browser's own prompt). */
function useLeaveGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers show the prompt only when this is set.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);
}

export function useUploads(options: UploadsOptions) {
  const [batch, setBatch] = useState<UploadBatch | null>(null);
  // Where the batch goes, fixed when it starts (the open folder may change).
  const [destination, setDestination] = useState<FolderCrumb | null>(null);
  // The batch's files and folder, for "Retry failed".
  const files = useRef<readonly File[]>([]);
  const parent = useRef<string | null>(null);
  const running = useRef(false);
  // Aborts the file in flight when the page goes away.
  const controller = useRef<AbortController | null>(null);
  const step: BatchStep = (update) => setBatch((current) => (current ? update(current) : current));
  const active = batch !== null && !batchSummary(batch).finished;
  useLeaveGuard(active);
  useEffect(() => () => controller.current?.abort(), []);

  const run = async (indices: readonly number[]) => {
    if (indices.length === 0) return;
    running.current = true;
    const abort = new AbortController();
    controller.current = abort;
    try {
      await runUploads(files.current, indices, parent.current, DEPS, step, abort.signal);
    } finally {
      running.current = false;
      if (!abort.signal.aborted) {
        await options.onFinished().catch((err: unknown) => {
          captureClientError(err, { scope: "files.drive.refresh" });
        });
      }
    }
  };

  const start = (picked: readonly File[]): StartResult => {
    if (picked.length === 0) return "empty";
    if (running.current) return "busy";
    files.current = picked;
    parent.current = options.folder?.externalId ?? null;
    const first = startBatch(
      picked.map((file) => ({ name: file.name, size: file.size })),
      options.maxFileBytes,
    );
    setBatch(first);
    setDestination(options.folder);
    void run(pendingIndices(first));
    return "started";
  };

  const retry = () => {
    if (running.current || batch === null) return;
    const again = retryableIndices(batch);
    setBatch(resetForRetry(batch, again));
    void run(again);
  };

  return {
    batch,
    destination,
    running: active,
    start,
    retry,
    /** Drops a finished batch's list. */
    clear: () => {
      if (!running.current) setBatch(null);
    },
  };
}
