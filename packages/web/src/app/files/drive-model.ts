/**
 * Managing the Klorn drive on /files (D3's web UI step) — the pure rules:
 * which rows may be changed, where a request goes, the name check, the
 * storage line, and the folder picker of "Move". Decision V4 keeps every
 * external source (Google Drive and the rest) read-only; only the Klorn
 * drive's own rows are renamed, moved or deleted here.
 */

import type { DriveFileWire, DriveLimitsResponse } from "@klorn/contract";
import type { DriveMessageKey } from "./drive-errors";
import { formatFileSize } from "./model";
import type { FolderCrumb } from "./open";

export const DRIVE_LIMITS_PATH = "/api/drive/limits";
export const DRIVE_UPLOAD_PATH = "/api/drive/files";
export const DRIVE_FOLDERS_PATH = "/api/drive/folders";

/** The list's `folder` value for the Klorn drive's top level (api routes/drive.ts). */
const ROOT_FOLDER = "root";
/**
 * The longest name the server keeps, in characters (api drive/klorn-file-name.ts).
 * The server accepts up to 1,000 characters of input and cuts a longer name to
 * this length; the page refuses it instead, so a name is never cut silently.
 */
export const NAME_MAX_CHARS = 255;
const RESERVED_NAMES = new Set([".", ".."]);
const KLORN_PROVIDER = "KLORN";

/** A row of the person's own Klorn drive: the only kind this page changes. */
export function isKlornEditable(file: DriveFileWire): boolean {
  return file.provider === KLORN_PROVIDER && !file.readOnly;
}

/** PATCH and DELETE of one row. */
export function driveItemPath(id: string): string {
  return `/api/drive/files/${encodeURIComponent(id)}`;
}

export type NameErrorKey =
  | "files.drive.name.required"
  | "files.drive.name.reserved"
  | "files.drive.name.tooLong"
  | DriveMessageKey;

/**
 * Why a name cannot be sent, or null. The server cleans it further (control
 * characters, NFC) and has the last word. Here: no name, "." or "..", which
 * the server refuses, and a name longer than it keeps (counted in
 * characters, as the server counts), which it would cut short.
 */
export function nameErrorKey(raw: string): NameErrorKey | null {
  const name = raw.trim();
  if (name.length === 0) return "files.drive.name.required";
  if (RESERVED_NAMES.has(name)) return "files.drive.name.reserved";
  if ([...name].length > NAME_MAX_CHARS) return "files.drive.name.tooLong";
  return null;
}

/** What a row's menu does (dialog-state.ts names the sheets after these). */
export type DriveChange = "rename" | "move" | "delete";
/** Every write a sheet sends: a row's change, or "New folder". */
export type DriveWrite = DriveChange | "create";

/**
 * Whether the change takes the row out of the list on screen: a delete always;
 * a move only when the list is one folder's (the unfiltered list shows every
 * row wherever it lives); a rename never.
 */
export function removesFromList(change: DriveChange, inFolder: boolean): boolean {
  if (change === "delete") return true;
  return change === "move" && inFolder;
}

/**
 * Where focus may go when a row leaves the list, in order: the rows after
 * it, nearest first, then the rows before it, nearest first. The caller takes
 * the first one still on screen once the fresh list has rendered.
 */
export function focusCandidates(ids: readonly string[], changedId: string): string[] {
  const at = ids.indexOf(changedId);
  if (at === -1) return [];
  return [...ids.slice(at + 1), ...ids.slice(0, at).reverse()];
}

/**
 * A refusal that says the list on screen is out of date: the row is gone
 * (`not-found`); the folder a move or a new folder aimed at is gone
 * (`parent-not-found`: the picker's level, or the open folder, is stale); a folder delete that storage cut short (503,
 * retryable) already took some of its rows with it; or the request timed out
 * and may have happened anyway.
 */
export function refreshesAfterFailure(write: DriveWrite, key: DriveMessageKey): boolean {
  if (key === "files.drive.error.notFound" || key === "files.drive.error.timeout") return true;
  if (write === "move" || write === "create") return key === "files.drive.error.parentNotFound";
  return write === "delete" && key === "files.drive.error.storage";
}

/** "X of Y used": both sizes formatted; no quota while the server has none. */
export function driveUsage(
  limits: DriveLimitsResponse,
  locale: string,
): { used: string; quota: string | null } {
  return {
    used: formatFileSize(limits.usedBytes, locale),
    quota: limits.quotaBytes === null ? null : formatFileSize(limits.quotaBytes, locale),
  };
}

// ── Move: the folder picker ─────────────────────────────────────────────────
// A trail of the folders opened from the top level (empty: the top level).

/** The list's `folder` filter for the picker's current level. */
export function pickerListFolder(trail: readonly FolderCrumb[]): string {
  return trail.at(-1)?.externalId ?? ROOT_FOLDER;
}

/** Where "Move here" puts the item: a folder's externalId, or null for the top level. */
export function pickerTarget(trail: readonly FolderCrumb[]): string | null {
  return trail.at(-1)?.externalId ?? null;
}

/** One level down. A new array. */
export function pickerEnter(trail: readonly FolderCrumb[], folder: DriveFileWire): FolderCrumb[] {
  return [...trail, { id: folder.id, externalId: folder.externalId, name: folder.name }];
}

/** One level up. A new array. */
export function pickerUp(trail: readonly FolderCrumb[]): FolderCrumb[] {
  return trail.slice(0, -1);
}

export interface MoveChoice {
  folder: DriveFileWire;
  /** False for the folder being moved: nothing inside it is a valid place. */
  enterable: boolean;
}

/** The folders of one level, with the moved folder shown but closed. */
export function moveChoices(files: readonly DriveFileWire[], item: DriveFileWire): MoveChoice[] {
  return files
    .filter((file) => file.isFolder)
    .map((folder) => ({ folder, enterable: folder.id !== item.id }));
}

/**
 * Whether "Move here" may be pressed: not where the item already is, and not
 * into itself. A folder inside it cannot be reached (it never opens), and the
 * server refuses any cycle anyway (409 `cycle`).
 */
export function canMoveHere(item: DriveFileWire, target: string | null): boolean {
  if (target === item.parentExternalId) return false;
  return target !== item.externalId;
}
