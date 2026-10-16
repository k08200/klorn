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

/** A Drive id: base64url-like, as Google mints them (28 to 44 characters today). */
const GOOGLE_DRIVE_ID = /^[A-Za-z0-9_-]{10,128}$/;
/** A whole byte count as Drive sends it (an int64 as text). */
const WHOLE_NUMBER = /^\d{1,16}$/;
const HTTP_NOT_FOUND = 404;

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

/** The first `reason` of a Drive error (`userRateLimitExceeded`, `appNotAuthorizedToFile`, ...). */
export function googleErrorReason(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as {
    errors?: Array<{ reason?: unknown }>;
    response?: { data?: { error?: { errors?: Array<{ reason?: unknown }> } } };
  };
  const reason = e.errors?.[0]?.reason ?? e.response?.data?.error?.errors?.[0]?.reason;
  return typeof reason === "string" ? reason : null;
}

/** A value inside a single-quoted string of Drive's query language: `\` and `'` escaped. */
export function quoteDriveQueryValue(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}
