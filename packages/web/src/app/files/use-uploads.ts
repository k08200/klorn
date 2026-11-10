"use client";

/**
 * Uploading picked files into the open Klorn drive folder, one after another
 * (one file per request, D3; the run itself is upload-run.ts). Files over the
 * cap fail before any request. "Retry failed" sends again the files that may
 * pass now (the rate limit, the network, a server fault, the skipped ones),
 * into the folder the batch was started in; "Cancel" stops a running batch
 * (the file in flight is aborted, the rest skipped). The list and the usage
 * are read again once each run ends, not after every file.
 *
 * A batch outlives the page: an in-app navigation away from /files does not
 * stop it. When it ends off the page, a toast says how it went (the batch's
 * list does not survive the page). Before each file it checks that the
 * session that started it is still the one signed in. While it runs, leaving
 * the site (a reload, closing the tab) asks first, except on the signed-out
 * path. There is no per-file deadline: a 25 MiB file can rightly be slow.
 */

import { useEffect, useRef, useState } from "react";
import { useToast } from "../../components/toast";
import { getStoredAuthToken } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { captureClientError } from "../../lib/sentry";
import { driveErrorKey, isUnexpectedDriveError } from "./drive-errors";
import type { FolderCrumb } from "./open";
import {
  backgroundResult,
  batchSummary,
  cancelBatch,
  pendingIndices,
  resetForRetry,
  retryableIndices,
  startBatch,
  type UploadBatch,
} from "./upload-model";
import {
  type BatchStep,
  boundToSession,
  runUploads,
  type UploadDeps,
  warnsOnLeave,
} from "./upload-run";
import { uploadDriveFile } from "./use-klorn-drive";

/** The run's requests, bound to the session that started it. */
function depsFor(owner: string | null): UploadDeps {
  return {
    upload: boundToSession(owner, getStoredAuthToken, uploadDriveFile),
    classify: driveErrorKey,
    report: (err, key) => {
      if (isUnexpectedDriveError(key)) captureClientError(err, { scope: "files.drive.upload" });
    },
  };
}

/** For the life of a run: leaving the site asks first (the browser's own prompt). */
function guardLeaving(): () => void {
  const warn = (event: BeforeUnloadEvent) => {
    if (!warnsOnLeave(getStoredAuthToken())) return;
    event.preventDefault();
    // Older browsers show the prompt only when this is set.
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", warn);
  return () => window.removeEventListener("beforeunload", warn);
}

interface UploadsOptions {
  /** The folder new files go into; null for the drive's top level. */
  folder: FolderCrumb | null;
  maxFileBytes: number;
  onFinished: () => Promise<void>;
}

/** What became of a pick or a drop: sent, refused because a run is going, or nothing picked. */
export type StartResult = "started" | "busy" | "empty";

export function useUploads(options: UploadsOptions) {
  const { t } = useT();
  const { toast } = useToast();
  const [batch, setBatch] = useState<UploadBatch | null>(null);
  // Where the batch goes, fixed when it starts (the open folder may change).
  const [destination, setDestination] = useState<FolderCrumb | null>(null);
  // The batch as the run sees it, kept past the page: state updates stop there.
  const latest = useRef<UploadBatch | null>(null);
  // The batch's files and folder, for "Retry failed".
  const files = useRef<readonly File[]>([]);
  const parent = useRef<string | null>(null);
  const running = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const show = (next: UploadBatch | null) => {
    latest.current = next;
    setBatch(next);
  };
  const step: BatchStep = (update) => show(latest.current ? update(latest.current) : null);

  /** A run that ended after the person left /files: a toast says how it went. */
  const reportOffPage = () => {
    if (mounted.current || latest.current === null) return;
    const result = backgroundResult(latest.current);
    toast(t(result.key, result.vars), result.failed ? "error" : "success");
  };

  const run = async (indices: readonly number[]) => {
    if (indices.length === 0) return;
    running.current = true;
    const abort = new AbortController();
    controller.current = abort;
    const unguard = guardLeaving();
    try {
      const deps = depsFor(getStoredAuthToken());
      await runUploads(files.current, indices, parent.current, deps, step, abort.signal);
      if (abort.signal.aborted) step(cancelBatch);
    } finally {
      unguard();
      running.current = false;
      controller.current = null;
      await options.onFinished().catch((err: unknown) => {
        captureClientError(err, { scope: "files.drive.refresh" });
      });
      reportOffPage();
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
    show(first);
    setDestination(options.folder);
    void run(pendingIndices(first));
    return "started";
  };

  const retry = () => {
    const current = latest.current;
    if (running.current || current === null) return;
    const again = retryableIndices(current);
    show(resetForRetry(current, again));
    void run(again);
  };

  return {
    batch,
    destination,
    running: batch !== null && !batchSummary(batch).finished,
    start,
    retry,
    /** Stops the running batch: the file in flight is aborted, the rest skipped. */
    cancel: () => controller.current?.abort(),
    /** Drops a finished batch's list. */
    clear: () => {
      if (!running.current) show(null);
    },
  };
}
