"use client";

/**
 * The Klorn drive on /files (D3's web UI step): whether it is on for this
 * person, its limits, and the requests that change it. GET /api/drive/limits
 * is the probe: Fastify's default 404 says the drive is off (the flag, or the
 * person is not in the rollout), and then the page offers nothing to change,
 * exactly as before. Every request goes through apiFetch (the session's
 * Bearer token, the 401 handling); the upload's multipart body keeps the
 * browser's own Content-Type. Nothing here calls a model.
 */

import type {
  DriveCreateFolderRequest,
  DriveDeleteResponse,
  DriveFileWire,
  DriveLimitsResponse,
  DriveUpdateFileRequest,
  DriveUploadResponse,
} from "@klorn/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { apiFetch } from "../../lib/api";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";
import { driveErrorKey, isDriveOff, isUnexpectedDriveError } from "./drive-errors";
import {
  DRIVE_FOLDERS_PATH,
  DRIVE_LIMITS_PATH,
  DRIVE_UPLOAD_PATH,
  driveItemPath,
} from "./drive-model";
import { uploadForm } from "./upload-model";

/** Retries of a probe that failed for another reason than the drive being off. */
const LIMITS_RETRIES = 2;

async function readLimits(): Promise<DriveLimitsResponse | null> {
  try {
    return await apiFetch<DriveLimitsResponse>(DRIVE_LIMITS_PATH);
  } catch (err) {
    if (isDriveOff(err)) return null;
    captureClientError(err, { scope: "files.drive.limits" });
    throw err;
  }
}

/**
 * `live`: the drive answered its limits. Off (404) and a probe that keeps
 * failing both leave it false, so nothing is offered that could not work.
 */
export function useKlornDrive(): { live: boolean; limits: DriveLimitsResponse | null } {
  const query = useQuery({
    queryKey: queryKeys.drive.limits(),
    queryFn: readLimits,
    retry: (count) => count < LIMITS_RETRIES,
  });
  const limits = query.data ?? null;
  return { live: limits !== null, limits };
}

/**
 * Re-read what a change can move: the lists (every folder and search), Today's
 * recent files, one-row reads (the folder trail) and the usage. Not the Google
 * Drive accounts, which no change here touches.
 */
export function useDriveRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.drive.all,
      predicate: (query) => query.queryKey[1] !== "google",
    });
  }, [queryClient]);
}

/** Reports a failure that is not the person's news, and hands back its message key. */
export function reportDriveError(err: unknown, scope: string) {
  const key = driveErrorKey(err);
  if (isUnexpectedDriveError(key)) captureClientError(err, { scope });
  return key;
}

export async function uploadDriveFile(
  file: File,
  parentExternalId: string | null,
): Promise<DriveFileWire> {
  const answer = await apiFetch<DriveUploadResponse>(DRIVE_UPLOAD_PATH, {
    method: "POST",
    body: uploadForm(file, parentExternalId),
  });
  return answer.file;
}

export async function createDriveFolder(request: DriveCreateFolderRequest): Promise<DriveFileWire> {
  const answer = await apiFetch<DriveUploadResponse>(DRIVE_FOLDERS_PATH, {
    method: "POST",
    body: JSON.stringify(request),
  });
  return answer.file;
}

export async function updateDriveItem(
  id: string,
  change: DriveUpdateFileRequest,
): Promise<DriveFileWire> {
  const answer = await apiFetch<DriveUploadResponse>(driveItemPath(id), {
    method: "PATCH",
    body: JSON.stringify(change),
  });
  return answer.file;
}

export async function deleteDriveItem(id: string): Promise<DriveDeleteResponse["deleted"]> {
  const answer = await apiFetch<DriveDeleteResponse>(driveItemPath(id), { method: "DELETE" });
  return answer.deleted;
}
