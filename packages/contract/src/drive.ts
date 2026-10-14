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
  | "storage-unavailable";

/** Every 4xx/5xx of the routes below. `retryable`: the same request may pass later. */
export interface DriveErrorResponse {
  error: string;
  code: DriveErrorCode;
  retryable: boolean;
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
