/**
 * Wire contract for `/api/drive` — the metadata index of a user's files across
 * sources (step D2 of docs/providers/unified-platform-plan.md). Read-only:
 * upload, download and delete arrive with the Klorn drive (D3).
 *
 * Both routes answer exactly like an unregistered route while the server's
 * DRIVE_ENABLED flag is off. A file is listed only while its provider's own
 * connector is enabled; no storage key, content or summary ever crosses the wire.
 */

/** Where a file lives. KLORN: Klorn's own drive, which also holds what a device imported. */
export type DriveProviderWire = "KLORN" | "GOOGLE" | "ONEDRIVE";

export interface DriveFileWire {
  id: string;
  provider: DriveProviderWire;
  /** Which source of that provider: opaque, stable, pairs with `provider`. */
  sourceKey: string;
  /** The file's id in its source. */
  externalId: string;
  /**
   * Written by whoever named the file, which for a shared file is not the user.
   * Render it as text; never as markup.
   */
  name: string;
  mimeType: string | null;
  isFolder: boolean;
  /** Null for a folder, or when the source reports no size. */
  sizeBytes: number | null;
  /**
   * The containing folder's `externalId` in the same source. Null means no
   * parent is KNOWN: the file is at the source's root, or its folder is not in
   * the index (a file picked from Google Drive on its own, for one). So null is
   * not "at the root", and the files with a null parent are not a root listing.
   */
  parentExternalId: string | null;
  /** ISO 8601, the source's own modified time. */
  modifiedAt: string;
  /** An https link to the file in its own service; null for a file Klorn holds. */
  webUrl: string | null;
  /**
   * Derived from `provider`: true for every file of an external source (Klorn
   * lists it, never edits it), false for a file in the Klorn drive.
   */
  readOnly: boolean;
}

/**
 * `GET /api/drive/files` — newest first. Query: `q` (name search; the first 100
 * characters are used, and a blank `q` lists), `provider`, `sourceKey`, `limit`
 * (default 50; a larger value than 100 is served 100) and `cursor` (the previous
 * page's `nextCursor`). A malformed `cursor` answers 400 `{ error }`.
 */
export interface DriveFilesListResponse {
  files: DriveFileWire[];
  /** Null on the last page. Opaque: pass it back unchanged. */
  nextCursor: string | null;
}

/**
 * `GET /api/drive/files/:id` — one file's metadata. Answers 404 `{ error }` for
 * an unknown id, another user's id, a trashed file and a file whose provider is
 * disabled, all alike.
 */
export interface DriveFileResponse {
  file: DriveFileWire;
  /**
   * The file's summary (D4). Present only while DRIVE_SUMMARIES_ENABLED is on:
   * null when the file has none yet. Absent while off, so the response is D2's,
   * and absent when the summary could not be read.
   */
  summary?: DriveFileSummaryWire | null;
}

// ── File summaries (step D4) ────────────────────────────────────────────────
//
// Behind DRIVE_SUMMARIES_ENABLED (and DRIVE_ENABLED; a file is summarised only
// while its provider is visible). While off, POST .../summarize answers exactly
// like an unregistered route, the file response has no `summary` and the `q`
// search matches names only. While on, `q` also matches summary text.

/**
 * PENDING: queued, or waiting on a cap (`error` says which: `cost-cap`,
 * `daily-limit`, `file-limit`, `rate-limited`), on an outage it keeps retrying
 * (`llm-unavailable`, `storage-error`), or on a file it cannot read for now
 * (`source-unavailable`: trashed, hidden, storage off). DONE: `text` is the
 * summary. FAILED: gave up on a content error (`llm-bad-output`,
 * `llm-rejected`, `object-missing`, `interrupted`, `internal`). SKIPPED: nothing
 * to summarise (`folder`, `unsupported-type`, `too-large`, `no-text`).
 */
export type DriveSummaryStatusWire = "PENDING" | "DONE" | "FAILED" | "SKIPPED";

/** Why a summary is not DONE. Branch on this; there is no message. */
export type DriveSummaryErrorCode =
  | "folder"
  | "unsupported-type"
  | "too-large"
  | "no-text"
  | "object-missing"
  | "source-unavailable"
  | "storage-error"
  | "cost-cap"
  | "daily-limit"
  | "file-limit"
  | "rate-limited"
  | "llm-unavailable"
  | "llm-bad-output"
  | "llm-rejected"
  | "interrupted"
  | "internal";

export interface DriveFileSummaryWire {
  status: DriveSummaryStatusWire;
  /** The summary, model output about the file: show it as text, never as markup. Null unless DONE. */
  text: string | null;
  error: DriveSummaryErrorCode | null;
  /** ISO 8601, when `text` was made. Null unless DONE. */
  summarizedAt: string | null;
}

/**
 * `POST /api/drive/files/:id/summarize` — summarise the file now if it is due
 * (a new or changed file; a FAILED one, which this retries unless it was
 * `interrupted`; one waiting out an outage, whose wait this lifts), else answer its
 * current state. 404 `{ error }` as `GET /api/drive/files/:id`. Rate limited
 * (429). The extracted file text is never returned.
 */
export interface DriveSummarizeResponse {
  summary: DriveFileSummaryWire;
}

// ── The Klorn drive (step D3) ───────────────────────────────────────────────
//
// Upload, folders, download, rename/move and delete for KLORN files only. Every
// route below answers exactly like an unregistered route unless DRIVE_ENABLED,
// KLORN_DRIVE_ENABLED and OBJECT_STORAGE_ENABLED are all on. A file of an
// external source (`readOnly: true`) answers 409 `read-only` on each of them.
//
// `GET /api/drive/files` also takes `folder`: a Klorn folder's `externalId`, or
// `root`, to list that folder's children (KLORN only).

/** Why a drive request failed. Branch on this, never on `error`. */
export type DriveErrorCode =
  | "invalid-upload"
  | "invalid-name"
  | "not-found"
  | "parent-not-found"
  | "read-only"
  | "is-folder"
  | "cycle"
  | "too-deep"
  | "folder-too-large"
  | "account-purging"
  | "too-large"
  | "quota-exceeded"
  | "quota-not-configured"
  | "multipart-malformed"
  | "rate-limited"
  | "storage-unavailable";

/** Every 4xx/5xx of the routes below. `retryable`: the same request may pass later. */
export interface DriveErrorResponse {
  error: string;
  code: DriveErrorCode;
  retryable: boolean;
}

/**
 * `GET /api/drive/limits` — what an upload may be, read before a client offers
 * one (the Mac app's import, D7). Behind the same gate as the routes below: the
 * server's default 404 while the Klorn drive is off. `Cache-Control: no-store`.
 */
export interface DriveLimitsResponse {
  /** The largest file an upload accepts, in bytes (25 MiB). */
  maxFileBytes: number;
  /** The user's limit in bytes; null while every upload is refused for want of one (`quota-not-configured`). */
  quotaBytes: number | null;
  /** The recorded size of the user's Klorn files, in bytes. */
  usedBytes: number;
}

/**
 * `POST /api/drive/files` — multipart/form-data, in this order:
 *   - `size`: the file's exact byte length (decimal), required;
 *   - `parentExternalId`: a Klorn folder's `externalId`, optional (root when absent);
 *   - `file`: the file itself, exactly one part; its filename is the file's name.
 * The type is sniffed from the bytes; the part's Content-Type is ignored. The
 * largest file is 25 MiB (26,214,400 bytes; 413 `too-large`). Answers 201.
 */
export interface DriveUploadResponse {
  file: DriveFileWire;
}

/** `POST /api/drive/folders`. Answers 201 `{ file }` (the folder). */
export interface DriveCreateFolderRequest {
  name: string;
  /** A Klorn folder's `externalId`; absent or null for the root. */
  parentExternalId?: string | null;
}

/**
 * `PATCH /api/drive/files/:id` — rename, move, or both. A field left out is left
 * as it is; `parentExternalId: null` moves to the root. Answers `{ file }`.
 */
export interface DriveUpdateFileRequest {
  name?: string;
  parentExternalId?: string | null;
}

/**
 * `GET /api/drive/files/:id/download` — a signed link to the file's bytes,
 * minted per request and valid for `expiresInSeconds` (at most 300). Open it
 * WITHOUT Klorn's Authorization header (a plain navigation in the browser, a
 * fresh request in the app): it is a link to the storage vendor. It always
 * downloads as an attachment. Folders answer 409 `is-folder`.
 */
export interface DriveDownloadResponse {
  url: string;
  expiresInSeconds: number;
}

/**
 * `DELETE /api/drive/files/:id` — permanent; there is no trash. A folder goes
 * with everything in it, up to a bound (409 `folder-too-large` past it). A
 * storage failure answers 503 `storage-unavailable` with what was deleted
 * already gone; sending the same request again continues.
 */
export interface DriveDeleteResponse {
  deleted: { files: number; folders: number };
}

// ─── Google Drive accounts (D5b, D5c) ─────────────────────────────────────────
// `/api/drive/google`: link and unlink a Google account for its picked files
// (drive.file only), and index the files picked in the Google Picker. Every
// route answers exactly like an unregistered one while the server's
// DRIVE_ENABLED or GOOGLE_DRIVE_ENABLED flag is off. No token crosses the wire
// except the Picker's own (`GoogleDrivePickerSessionResponse`), by design.

/**
 * `POST /api/drive/google/link` — the Google consent URL to send the browser
 * to. The callback lands it back on `/files?drive=<GoogleDriveLinkOutcome>`.
 */
export interface GoogleDriveLinkResponse {
  url: string;
}

/**
 * The `drive` query value of `/files` after a link:
 *   - `success`: linked (or re-linked in place);
 *   - `scope-missing`: Google Drive access was unticked at consent; nothing stored;
 *   - `unverified`: Google has not verified that address; nothing stored;
 *   - `limit`: the user already has the most accounts (5); nothing stored;
 *   - `failed`: anything else, the feature turned off meanwhile included.
 */
export type GoogleDriveLinkOutcome =
  | "success"
  | "failed"
  | "unverified"
  | "scope-missing"
  | "limit";

/** One linked Google Drive account. */
export interface GoogleDriveAccountWire {
  id: string;
  email: string;
  /** The grant stopped working (revoked, or unreadable): only a re-link fixes it. */
  needsReconnect: boolean;
  /** ISO 8601. */
  createdAt: string;
}

/** `GET /api/drive/google/accounts` — the user's accounts, oldest first. */
export interface GoogleDriveAccountsResponse {
  accounts: GoogleDriveAccountWire[];
}

/**
 * `DELETE /api/drive/google/accounts/:id` — the account and every file indexed
 * from it are removed from Klorn. Klorn does not revoke the grant at Google (a
 * grant shared with the primary's Gmail would go with it); the user can remove
 * it in their Google account. 404 `{ error }` for an id that is not the user's.
 */
export interface GoogleDriveUnlinkResponse {
  success: true;
}

/**
 * `POST /api/drive/google/accounts/:id/picker-session` — what the browser's
 * Google Picker needs, minted on click and sent `Cache-Control: no-store`. The
 * ONE response that carries a token: the Picker runs in the browser and cannot
 * work without it. It is a drive.file access token (about an hour), never
 * stored or logged by Klorn. 503 `{ code: "picker-not-configured" }` while the
 * server lacks the key or the project number; 409 `{ code: "needs-reconnect" }`
 * when the grant stopped working; 404 for an account that is not the user's.
 */
export interface GoogleDrivePickerSessionResponse {
  accessToken: string;
  /** The browser API key (`setDeveloperKey`); public, restricted to the web origin. */
  developerKey: string;
  /** The Cloud project number (`setAppId`); public. */
  appId: string;
}

/** `POST /api/drive/google/accounts/:id/picked` — the Picker's ids, and nothing else: 1 to 50. */
export interface GoogleDrivePickedRequest {
  ids: string[];
}

/**
 * Why one picked id was not indexed:
 *   - `not-accessible`: Google does not show it to this grant (or it is in the trash);
 *   - `folder`, `shortcut`: only files can be picked;
 *   - `cap`: the account already has the most files Klorn indexes from it (500);
 *   - `invalid`: not a Drive file id, or metadata Klorn cannot store.
 */
export type GoogleDrivePickRefusalCode =
  | "not-accessible"
  | "folder"
  | "shortcut"
  | "cap"
  | "invalid";

export interface GoogleDrivePickRefusal {
  id: string;
  code: GoogleDrivePickRefusalCode;
}

/**
 * The picked files Klorn indexed (a file picked again is refreshed, and counts),
 * and the ones it refused. 409 `{ code: "needs-reconnect" }` and 502
 * `{ code: "drive-unavailable" }` index nothing.
 */
export interface GoogleDrivePickedResponse {
  added: number;
  refused: GoogleDrivePickRefusal[];
}
