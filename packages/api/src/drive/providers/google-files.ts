/**
 * What Klorn reads of a Google Drive file, and how it becomes the seam's
 * ProviderDriveFile (step D5c of docs/providers/unified-platform-plan.md,
 * "Metadata"). Pure: no Google call here; drive/providers/google.ts makes them.
 *
 *   - The fields mask is the plan's list and nothing more. `webContentLink`,
 *     `exportLinks` and `thumbnailLink` are never requested: Klorn never
 *     fetches a URL Google hands it (providers/types.ts, the second rule).
 *   - The parent is `parents[0]`: under drive.file it is usually a folder the
 *     user never picked, so no row of it exists (drive-rows.ts, "NULL means").
 *   - The link is kept only over https on docs.google.com or drive.google.com.
 *   - The etag is `md5:<md5Checksum>` when Drive reports one (a rename keeps
 *     it), else `v:<version>` (a Google Doc has no checksum).
 *
 * Everything here is what Google said, uncleaned beyond these rules: the writer
 * (drive/drive-rows.ts) cleans the name, the type and the size again.
 *
 * D5d adds what a summary and the refresh need to know of Google: which of its
 * own formats export as text (and as which type), and how to read a failure
 * (a rate limit, an outage, the export's size limit) from a googleapis error.
 */

import { safeHttpsLinkOnHosts } from "../../safe-https-link.js";
import { driveLinkHosts } from "../drive-providers.js";
import type { ProviderDriveFile } from "./types.js";

/** `files.get`'s fields: exactly what a row needs (plan, D5 "Metadata"). */
export const GOOGLE_DRIVE_FILE_FIELDS =
  "id,name,mimeType,size,md5Checksum,version,modifiedTime,webViewLink,parents,trashed";
/** `files.list`'s fields: the same per file, and the page token. */
export const GOOGLE_DRIVE_LIST_FIELDS = `nextPageToken,files(${GOOGLE_DRIVE_FILE_FIELDS})`;

export const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
export const GOOGLE_SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

/** Google's own formats (Docs, Sheets, a form...): no bytes of their own to download. */
const GOOGLE_APPS_PREFIX = "application/vnd.google-apps.";
/**
 * The Google formats a summary can read, and the type Drive exports each as
 * (plan, D5 "Summaries"). A Sheet exports its first sheet only (prior
 * knowledge, a live check before the flip). Any other Google format has no
 * text export: it is never fetched.
 */
export const GOOGLE_TEXT_EXPORTS: ReadonlyMap<string, string> = new Map([
  ["application/vnd.google-apps.document", "text/plain"],
  ["application/vnd.google-apps.presentation", "text/plain"],
  ["application/vnd.google-apps.spreadsheet", "text/csv"],
]);
/**
 * The reasons of a 403 that is a rate limit, not a refusal (prior knowledge of
 * Drive's error reference). A 429 is one whatever its reason.
 */
const GOOGLE_RATE_LIMIT_REASONS: ReadonlySet<string> = new Set([
  "userRateLimitExceeded",
  "rateLimitExceeded",
  "dailyLimitExceeded",
]);
/**
 * The reasons of a 403 that is about the file: it is there, but not this app's
 * (picked under another app id) or not this user's to read. Every other 403 (a
 * rate limit, the Drive API switched off, a missing scope, a key restriction)
 * is a fault of the setup or the grant.
 */
const FILE_LEVEL_FORBIDDEN_REASONS: ReadonlySet<string> = new Set([
  "appNotAuthorizedToFile",
  "insufficientFilePermissions",
]);
/** The export's own limit: the Google file is too large to export (D5d: `too-large`). */
const GOOGLE_EXPORT_TOO_LARGE_REASON = "exportSizeLimitExceeded";
/** The most of an error body read for its reason; an error body is a few hundred bytes. */
const ERROR_BODY_MAX_CHARS = 64 * 1024;
const ERROR_BODY_REASON = /"reason"\s*:\s*"([A-Za-z]{1,64})"/;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_FLOOR = 500;

/** A Drive id: base64url-like, as Google mints them (28 to 44 characters today). */
const GOOGLE_DRIVE_ID = /^[A-Za-z0-9_-]{10,128}$/;
/** A whole byte count as Drive sends it (an int64 as text). */
const WHOLE_NUMBER = /^\d{1,16}$/;

/** A Drive v3 file resource, limited to the fields above; any of them may be missing. */
export interface GoogleDriveFileResource {
  readonly id?: string | null;
  readonly name?: string | null;
  readonly mimeType?: string | null;
  readonly size?: string | null;
  readonly md5Checksum?: string | null;
  readonly version?: string | null;
  readonly modifiedTime?: string | null;
  readonly webViewLink?: string | null;
  readonly parents?: string[] | null;
  readonly trashed?: boolean | null;
}

/** True for a value shaped like a Drive file id: safe to put in a query or a path. */
export function isGoogleDriveId(value: unknown): value is string {
  return typeof value === "string" && GOOGLE_DRIVE_ID.test(value);
}

/**
 * The file's link when it is https on one of Google's two Drive hosts; else
 * null. The writer holds the same rule for every GOOGLE row (drive-rows.ts).
 */
export function googleWebUrl(link: unknown): string | null {
  return safeHttpsLinkOnHosts(link, driveLinkHosts("GOOGLE") ?? new Set());
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

/** `md5:<md5Checksum>` when Drive reports one, else `v:<version>`, else null. */
export function googleEtag(
  file: Pick<GoogleDriveFileResource, "md5Checksum" | "version">,
): string | null {
  if (nonEmpty(file.md5Checksum)) return `md5:${file.md5Checksum}`;
  return nonEmpty(file.version) ? `v:${file.version}` : null;
}

/** Drive's size (int64 as text) as a whole, safe number; null for none (a Google Doc). */
function googleSizeBytes(size: unknown): number | null {
  if (typeof size !== "string" || !WHOLE_NUMBER.test(size)) return null;
  const bytes = Number(size);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

/** The seam's view of one file resource. An invalid `modifiedTime` stays invalid: the writer refuses it. */
export function toProviderDriveFile(file: GoogleDriveFileResource): ProviderDriveFile {
  const mimeType = typeof file.mimeType === "string" ? file.mimeType : null;
  const parent = file.parents?.[0];
  return {
    externalId: typeof file.id === "string" ? file.id : "",
    name: typeof file.name === "string" ? file.name : "",
    mimeType,
    isFolder: mimeType === GOOGLE_FOLDER_MIME,
    sizeBytes: googleSizeBytes(file.size),
    parentExternalId: nonEmpty(parent) ? parent : null,
    modifiedAt: new Date(typeof file.modifiedTime === "string" ? file.modifiedTime : Number.NaN),
    webUrl: googleWebUrl(file.webViewLink),
    etag: googleEtag(file),
    trashed: file.trashed === true,
  };
}

/** The HTTP status of a googleapis (gaxios) error, wherever this version puts it; null for none. */
export function googleErrorStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { status?: unknown; response?: { status?: unknown }; code?: unknown };
  for (const candidate of [e.status, e.response?.status, e.code]) {
    const status = Number(candidate);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  return null;
}

/** True for Google's "no such file, or not one this grant can see". */
export function isGoogleNotFound(err: unknown): boolean {
  return googleErrorStatus(err) === HTTP_NOT_FOUND;
}

/**
 * The first `reason` of a Drive error (`userRateLimitExceeded`,
 * `appNotAuthorizedToFile`, ...). A streamed request's error (D5d's byte read)
 * carries the body as text, not parsed: its reason is read from that text.
 */
export function googleErrorReason(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as {
    errors?: Array<{ reason?: unknown }>;
    response?: { data?: unknown };
  };
  const data = e.response?.data as { error?: { errors?: Array<{ reason?: unknown }> } } | undefined;
  const reason = e.errors?.[0]?.reason ?? data?.error?.errors?.[0]?.reason;
  if (typeof reason === "string") return reason;
  const body = e.response?.data;
  if (typeof body !== "string" || body.length > ERROR_BODY_MAX_CHARS) return null;
  return ERROR_BODY_REASON.exec(body)?.[1] ?? null;
}

/** A 429, or a 403 whose reason is a rate limit: Google asks Klorn to slow down. */
export function isGoogleRateLimited(err: unknown): boolean {
  const status = googleErrorStatus(err);
  if (status === HTTP_TOO_MANY_REQUESTS) return true;
  return status === HTTP_FORBIDDEN && GOOGLE_RATE_LIMIT_REASONS.has(googleErrorReason(err) ?? "");
}

/** A 403 about this one file (see FILE_LEVEL_FORBIDDEN_REASONS), not about the setup or the grant. */
export function isGoogleFileForbidden(err: unknown): boolean {
  return (
    googleErrorStatus(err) === HTTP_FORBIDDEN &&
    FILE_LEVEL_FORBIDDEN_REASONS.has(googleErrorReason(err) ?? "")
  );
}

/** Google's "this file is too large to export": a 403 with the export's own reason. */
export function isGoogleExportTooLarge(err: unknown): boolean {
  return (
    googleErrorStatus(err) === HTTP_FORBIDDEN &&
    googleErrorReason(err) === GOOGLE_EXPORT_TOO_LARGE_REASON
  );
}

/** Worth trying again later: a rate limit, a 5xx, or no answer at all (a network error). */
export function isGoogleRetryable(err: unknown): boolean {
  const status = googleErrorStatus(err);
  return status === null || status >= HTTP_SERVER_ERROR_FLOOR || isGoogleRateLimited(err);
}

/** A failure as it may be logged: its status and reason, nothing else of the request. */
export function googleFailureLabel(err: unknown): string {
  const status = googleErrorStatus(err) ?? "no response";
  const reason = googleErrorReason(err);
  return reason === null ? String(status) : `${status} ${reason}`;
}

/** True for one of Google's own formats. */
export function isGoogleAppsType(mimeType: string | null): boolean {
  return typeof mimeType === "string" && mimeType.startsWith(GOOGLE_APPS_PREFIX);
}

/** The type Drive exports this Google format as for its text; null for any other type. */
export function googleTextExportType(mimeType: string | null): string | null {
  return mimeType === null ? null : (GOOGLE_TEXT_EXPORTS.get(mimeType) ?? null);
}

/** A value inside a single-quoted string of Drive's query language: `\` and `'` escaped. */
export function quoteDriveQueryValue(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}
