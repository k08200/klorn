"use client";

/**
 * Downloading one Klorn drive file (P12 follow-up). GET
 * /api/drive/files/:id/download goes through apiFetch, so it carries the
 * Bearer token and the API's ownership check; the answer is a signed storage
 * link (at most 300 s, Content-Disposition: attachment with the server's
 * sanitised filename). The page navigates to that link without any Klorn
 * header — the storage origin has no CORS rule, so a fetch-as-blob would fail,
 * and navigating avoids holding the whole file in memory or a blob: URL to
 * revoke. The link is neither stored nor logged.
 */

import type { DriveDownloadResponse } from "@klorn/contract";
import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { captureClientError } from "../../lib/sentry";
import { type DownloadErrorKey, downloadErrorKey, downloadLinkPath, safeDownloadUrl } from "./open";

async function startDownload(id: string): Promise<void> {
  const answer = await apiFetch<DriveDownloadResponse>(downloadLinkPath(id));
  const url = safeDownloadUrl(answer?.url);
  // The message names no link: it reaches error reporting.
  if (url === null) throw new Error("drive download: the API answered an unusable link");
  window.location.assign(url);
}

export function useFileDownload(): {
  start: (id: string) => void;
  isPending: boolean;
  errorKey: DownloadErrorKey | null;
} {
  const mutation = useMutation({
    mutationFn: startDownload,
    // A gone file (404) or the rate limit (429) is the user's news, not a fault.
    onError: (err) => {
      if (downloadErrorKey(err) === "files.download.error") {
        captureClientError(err, { scope: "files.download" });
      }
    },
  });
  return {
    start: (id) => mutation.mutate(id),
    isPending: mutation.isPending,
    errorKey: mutation.isError ? downloadErrorKey(mutation.error) : null,
  };
}
