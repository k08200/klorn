/**
 * The Google Drive connector (step D5 of docs/providers/unified-platform-plan.md),
 * served by the dispatcher (providers/dispatch.ts) only while DRIVE_ENABLED and
 * GOOGLE_DRIVE_ENABLED are both on.
 *
 * `connect` answers a session only for an account that is the user's own, of
 * this provider, and not flagged for reconnect (the seam's first rule:
 * providers/types.ts); otherwise null. The account is loaded by (id, userId,
 * provider) every time: the DriveFile foreign key proves an account exists, not
 * who owns it.
 *
 * The session reads, and only reads (decision V4; drive.file has no read-only
 * variant, so google-drive-readonly-guard.test.ts holds it): one file's
 * metadata (D5c, for the Picker's ids and D5d's refresh), a folder's listing and
 * a name search, all through googleapis on the account's own OAuth client and
 * with the fields mask of google-files.ts. Klorn's own /files listing and search
 * read the index (drive/drive-read.ts), not these. The bytes for a summary are
 * D5d: until then `fetchForSummary` refuses, and the summary run never asks
 * (summary-policy.ts, DRIVE_SUMMARY_READABLE_PROVIDERS).
 */

import { google } from "googleapis";
import { loadDriveAccountCredentials } from "../linked-drive-accounts.js";
import { buildLinkedDriveClient, type LinkedDriveClient } from "./google-auth.js";
import {
  GOOGLE_DRIVE_FILE_FIELDS,
  GOOGLE_DRIVE_LIST_FIELDS,
  type GoogleDriveFileResource,
  isGoogleDriveId,
  isGoogleNotFound,
  quoteDriveQueryValue,
  toProviderDriveFile,
} from "./google-files.js";
import type {
  DriveListQuery,
  DriveProviderActions,
  DriveProviderSession,
  DriveSearchQuery,
  DriveSourceRef,
  ProviderDrivePage,
} from "./types.js";

/** Drive allows 1000 a page; Klorn never needs more than its own page ceiling. */
const GOOGLE_LIST_PAGE_MAX = 100;
const EMPTY_PAGE: ProviderDrivePage = { files: [], nextPageToken: null };

type DriveApi = ReturnType<typeof google.drive>;

/** One file's metadata; null when Google answers 404 (no such file, or not granted). */
async function getMetadata(api: DriveApi, externalId: string) {
  try {
    const res = await api.files.get({
      fileId: externalId,
      fields: GOOGLE_DRIVE_FILE_FIELDS,
      supportsAllDrives: true,
    });
    return toProviderDriveFile(res.data as GoogleDriveFileResource);
  } catch (err) {
    if (isGoogleNotFound(err)) return null;
    throw err;
  }
}

function pageSizeOf(requested: number): number {
  if (!Number.isInteger(requested) || requested < 1) return 1;
  return Math.min(requested, GOOGLE_LIST_PAGE_MAX);
}

/** One page of `files.list` for this query (already quoted), untrashed only. */
async function listPage(
  api: DriveApi,
  where: string,
  query: { readonly pageSize: number; readonly pageToken?: string },
): Promise<ProviderDrivePage> {
  const res = await api.files.list({
    q: `${where} and trashed = false`,
    fields: GOOGLE_DRIVE_LIST_FIELDS,
    pageSize: pageSizeOf(query.pageSize),
    ...(query.pageToken !== undefined && { pageToken: query.pageToken }),
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    spaces: "drive",
  });
  const resources = (res.data.files ?? []) as GoogleDriveFileResource[];
  return {
    files: resources.map(toProviderDriveFile),
    nextPageToken: typeof res.data.nextPageToken === "string" ? res.data.nextPageToken : null,
  };
}

async function listFolder(api: DriveApi, query: DriveListQuery): Promise<ProviderDrivePage> {
  const parent = query.parentExternalId ?? "root";
  // Only an id goes into the query: anything else lists nothing.
  if (parent !== "root" && !isGoogleDriveId(parent)) return EMPTY_PAGE;
  return await listPage(api, `${quoteDriveQueryValue(parent)} in parents`, query);
}

async function searchNames(api: DriveApi, query: DriveSearchQuery): Promise<ProviderDrivePage> {
  const text = query.text.trim();
  if (text === "") return EMPTY_PAGE;
  return await listPage(api, `name contains ${quoteDriveQueryValue(text)}`, query);
}

/** The session of one linked account: reads through its own OAuth client. */
export function googleDriveSession(linked: LinkedDriveClient): DriveProviderSession {
  const api = google.drive({ version: "v3", auth: linked.client });
  return {
    provider: "GOOGLE",
    list: (query) => listFolder(api, query),
    search: (query) => searchNames(api, query),
    getMetadata: (externalId) => getMetadata(api, externalId),
    fetchForSummary: () =>
      Promise.reject(new Error("Google Drive fetchForSummary is not available yet (D5d).")),
  };
}

async function connectGoogleDrive(source: DriveSourceRef): Promise<DriveProviderSession | null> {
  const account = await loadDriveAccountCredentials(source.userId, "GOOGLE", source.sourceKey);
  // A flagged account stays flagged until a re-link: no retry of a dead grant.
  if (!account || account.needsReconnect) return null;
  const linked = buildLinkedDriveClient(source.userId, account);
  return linked ? googleDriveSession(linked) : null;
}

export const googleDriveActions: DriveProviderActions = {
  provider: "GOOGLE",
  connect: connectGoogleDrive,
};
