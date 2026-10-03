/**
 * Wire contract for `/api/drive` — the metadata index of a user's files across
 * sources (step D2 of docs/providers/unified-platform-plan.md). Read-only:
 * upload, download and delete arrive with the Klorn drive (D3).
 *
 * Both routes answer exactly like an unregistered route while the server's
 * DRIVE_ENABLED flag is off. A file is listed only while its provider's own
 * connector is enabled; no storage key, content or summary ever crosses the wire.
 */

/** Where a file lives. KLORN: Klorn's own drive. DEVICE: imported from a device. */
export type DriveProviderWire = "KLORN" | "GOOGLE" | "ONEDRIVE" | "DEVICE";

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
  /** The containing folder's `externalId` in the same source; null at its root. */
  parentExternalId: string | null;
  /** ISO 8601, the source's own modified time. */
  modifiedAt: string;
  /** An https link to the file in its own service; null for a file Klorn holds. */
  webUrl: string | null;
  /** True for every file of an external source: Klorn lists it, never edits it. */
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
