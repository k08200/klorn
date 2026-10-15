"use client";

/**
 * Where /files is in the Klorn drive (P12 follow-up): the trail of folders
 * opened, kept in `?folder=<row id>` so a reload or a link from Today's recent
 * files opens the same folder. The folder in the URL is read through
 * GET /api/drive/files/:id, so it is the user's own row; anything but a Klorn
 * drive folder opens the whole list.
 */

import type { DriveFileResponse, DriveFileWire } from "@klorn/contract";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "../../lib/api";
import { FILES_HOME } from "../../lib/home";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";
import { FOLDER_PARAM, type FolderCrumb, fileOpenAction, folderHref, trailTo } from "./open";

const FOLDER_STALE_MS = 60_000;

/**
 * The Klorn drive folder /files was opened at (`?folder=<row id>`, from Today),
 * read through GET /api/drive/files/:id so the row is the user's own. Anything
 * but a Klorn drive folder opens the whole list.
 */
function useStartFolder(id: string | null): {
  resolving: boolean;
  crumb: FolderCrumb | null;
} {
  const query = useQuery({
    queryKey: queryKeys.drive.file(id ?? ""),
    queryFn: async () => {
      try {
        return await apiFetch<DriveFileResponse>(
          `/api/drive/files/${encodeURIComponent(id ?? "")}`,
        );
      } catch (err) {
        captureClientError(err, { scope: "files.folder" });
        throw err;
      }
    },
    enabled: id !== null,
    staleTime: FOLDER_STALE_MS,
    retry: false,
  });
  const file = query.data?.file;
  const crumb =
    file && fileOpenAction(file).kind === "folder"
      ? { id: file.id, externalId: file.externalId, name: file.name }
      : null;
  return { resolving: id !== null && query.isLoading, crumb };
}

export function useFolderTrail() {
  const router = useRouter();
  const param = useSearchParams().get(FOLDER_PARAM);
  const start = useStartFolder(param);
  // The trail walked here, for the URL it wrote. Any other ?folder= (a link
  // from Today, back/forward) starts again from the URL's folder.
  const [walked, setWalked] = useState<{ param: string | null; trail: FolderCrumb[] } | null>(null);
  const own = walked !== null && walked.param === param ? walked.trail : null;
  const trail = own ?? (start.crumb ? [start.crumb] : []);
  const walk = (next: FolderCrumb[]) => {
    const last = next.at(-1);
    setWalked({ param: last?.id ?? null, trail: next });
    router.replace(last ? folderHref(last.id) : FILES_HOME, { scroll: false });
  };
  return {
    trail,
    folder: trail.at(-1) ?? null,
    /** False while the URL's folder is still being read: list nothing yet. */
    ready: own !== null || !start.resolving,
    walkTo: (index: number) => walk(trailTo(trail, index)),
    open: (file: DriveFileWire) =>
      walk([...trail, { id: file.id, externalId: file.externalId, name: file.name }]),
  };
}
