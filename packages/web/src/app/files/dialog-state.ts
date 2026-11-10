/**
 * Which Klorn drive sheet is open on /files (D3's web UI step): one at a
 * time, each opening with its own token. A sheet closes only with the token
 * it was opened with, so an answer that arrives after another sheet opened
 * can never close that one. A closed sheet keeps its kind and row while it
 * animates out.
 */

import type { DriveFileWire } from "@klorn/contract";
import type { DriveChange } from "./drive-model";

export type RowAction = DriveChange;
export type DialogKind = "folder" | RowAction;

export interface DialogState {
  kind: DialogKind;
  /** The row the sheet acts on; null for "New folder". */
  file: DriveFileWire | null;
  open: boolean;
  token: number;
}

export function openDialog(
  current: DialogState | null,
  kind: DialogKind,
  file: DriveFileWire | null,
): DialogState {
  return { kind, file, open: true, token: (current?.token ?? 0) + 1 };
}

/** Closed, if `token` is the open sheet's; otherwise unchanged (the same object). */
export function closeDialog(current: DialogState | null, token: number): DialogState | null {
  if (current === null || current.token !== token || !current.open) return current;
  return { ...current, open: false };
}
