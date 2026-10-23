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
/** The longest name the server keeps, in characters (api drive/klorn-file-name.ts). */
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

export type NameErrorKey = "files.drive.name.required" | DriveMessageKey;

/**
 * Why a name cannot be sent, or null. The server cleans it further (control
 * characters, NFC) and has the last word; this only spares a request that
 * would certainly fail. Length counts characters, as the server does.
 */
export function nameErrorKey(raw: string): NameErrorKey | null {
  const name = raw.trim();
  if (name.length === 0) return "files.drive.name.required";
  if (RESERVED_NAMES.has(name) || [...name].length > NAME_MAX_CHARS) {
    return "files.drive.error.invalidName";
  }
  return null;
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
