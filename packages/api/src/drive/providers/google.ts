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
 * read the index (drive/drive-read.ts), not these.
 *
 * The bytes for a summary (D5d, `fetchForSummary`): a Doc or a Slides deck is
 * exported as text/plain and a Sheet as text/csv (its first sheet only), any
 * other file is read with alt=media. Through googleapis only, never a link
 * Google hands over: no field is requested at all, so no `webContentLink`,
 * `exportLinks` or `thumbnailLink`. The answer streams into `readCappedBytes`,
 * and the request and all its bytes get D4's deadline (summary-policy.ts):
 * past it the request is aborted and the body released. What fails:
 *   - a 404: null (the file is gone, or no longer this grant's);
 *   - Google's export size limit: `too-large`;
 *   - a 429, a rate-limit 403, a 5xx, no answer, the deadline, or a revoked
 *     grant (which the refresh job flags for reconnect): a retryable
 *     StorageError, which the run defers instead of failing;
 *   - anything else: a StorageError that is not retried.
 * A StorageError here names the status and Google's reason, never the error
 * itself: a googleapis error carries its request's Authorization header.
 */

import { google } from "googleapis";
import { isRevokedGrantError } from "../../pim/linked-calendar-failure.js";
import { StorageError } from "../../storage/errors.js";
import { loadDriveAccountCredentials } from "../linked-drive-accounts.js";
import { type CappedBytes, readCappedBytes } from "../summary-bytes.js";
import { DRIVE_SUMMARY_READ_TIMEOUT_MS } from "../summary-policy.js";
import { buildLinkedDriveClient, type LinkedDriveClient } from "./google-auth.js";
import {
  GOOGLE_DRIVE_FILE_FIELDS,
  GOOGLE_DRIVE_LIST_FIELDS,
  type GoogleDriveFileResource,
  googleErrorStatus,
  googleFailureLabel,
  googleTextExportType,
  isGoogleAppsType,
  isGoogleDriveId,
  isGoogleExportTooLarge,
  isGoogleNotFound,
  isGoogleRetryable,
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

interface ByteReadOptions {
  readonly maxBytes: number;
  readonly mimeType: string | null;
}

/** The request for one file's bytes: Google's text export of its own format, or the file itself. */
function requestBytes(
  api: DriveApi,
  externalId: string,
  mimeType: string | null,
  signal: AbortSignal,
) {
  const exportType = googleTextExportType(mimeType);
  const options = { responseType: "stream" as const, signal };
  if (exportType !== null) {
    return api.files.export({ fileId: externalId, mimeType: exportType }, options);
  }
  return api.files.get({ fileId: externalId, alt: "media", supportsAllDrives: true }, options);
}

/** A streamed answer's body: a Node or a web stream, both async-iterable. */
function bodyOf(data: unknown): AsyncIterable<Uint8Array> {
  if (typeof data === "object" && data !== null && Symbol.asyncIterator in data) {
    return data as AsyncIterable<Uint8Array>;
  }
  throw new StorageError("upstream", "Google Drive answered without a body");
}

/** Release a body whatever became of the read; a web stream is cancelled by the abort. */
function release(body: unknown): void {
  const destroy = (body as { destroy?: unknown } | null)?.destroy;
  if (typeof destroy === "function") destroy.call(body);
}

/** A failed byte read: null, `too-large`, or a StorageError naming the status and reason only. */
function byteReadFailure(err: unknown): CappedBytes | null {
  if (isGoogleNotFound(err)) return null;
  if (isGoogleExportTooLarge(err)) return { ok: false, reason: "too-large" };
  const status = googleErrorStatus(err);
  // A revoked grant: the refresh job flags the account; until then the summary waits.
  const retryable = isGoogleRetryable(err) || isRevokedGrantError(err);
  if (status === null) {
    throw new StorageError("unreachable", "Google Drive did not answer", { retryable });
  }
  throw new StorageError("upstream", `Google Drive answered ${googleFailureLabel(err)}`, {
    status,
    retryable,
  });
}

/** One file's bytes for its summary, capped while they stream, within D4's deadline. */
async function fetchForSummary(
  api: DriveApi,
  externalId: string,
  options: ByteReadOptions,
): Promise<CappedBytes | null> {
  if (!isGoogleDriveId(externalId)) return null;
  if (isGoogleAppsType(options.mimeType) && googleTextExportType(options.mimeType) === null) {
    // The summary run never asks (summary-extract.ts): alt=media would only be refused.
    throw new Error("Google Drive: this Google format has no text export");
  }
  const controller = new AbortController();
  let body: unknown = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new StorageError("unreachable", "Google Drive read timed out", { retryable: true })),
      DRIVE_SUMMARY_READ_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  const read = (async () => {
    const res = await requestBytes(api, externalId, options.mimeType, controller.signal);
    body = res.data;
    return await readCappedBytes(bodyOf(res.data), options.maxBytes);
  })();
  try {
    return await Promise.race([read, deadline]);
  } catch (err) {
    if (err instanceof StorageError) throw err;
    return byteReadFailure(err);
  } finally {
    clearTimeout(timer);
    // Released whatever the outcome: read whole, stopped at the cap, or abandoned.
    controller.abort();
    release(body);
    // A read that loses the race and then fails has nothing to report to.
    read.catch(() => {});
  }
}

/** The session of one linked account: reads through its own OAuth client. */
export function googleDriveSession(linked: LinkedDriveClient): DriveProviderSession {
  const api = google.drive({ version: "v3", auth: linked.client });
  return {
    provider: "GOOGLE",
    list: (query) => listFolder(api, query),
    search: (query) => searchNames(api, query),
    getMetadata: (externalId) => getMetadata(api, externalId),
    fetchForSummary: (externalId, options) => fetchForSummary(api, externalId, options),
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
