/**
 * Folders, rename and move in the Klorn drive (step D3 of
 * docs/providers/unified-platform-plan.md). A folder is a row with `isFolder`
 * (D2: parent, not path), and its children name it in `parentExternalId`.
 *
 * Two bounds keep every walk finite, whatever the rows say:
 *
 *   - DRIVE_MAX_FOLDER_DEPTH: no folder sits deeper than this (a folder at the
 *     root is depth 1). Creating a folder and moving one both check it, and the
 *     ancestor walk refuses to climb further, so a cycle that got into the rows
 *     by any route still ends.
 *   - DRIVE_FOLDER_WALK_MAX_ITEMS: the most rows one downward walk reads.
 *
 * A folder cannot be moved into itself or into one of its own folders: the walk
 * from the new parent up to the root must not meet it.
 *
 * Rename and move write through `updateDriveFileRow`, which only updates: a row
 * deleted while the request was in flight stays deleted (404), instead of
 * coming back as a file with no bytes. The row keeps its `modifiedAt`: the
 * content did not change.
 */

import { randomUUID } from "node:crypto";
import type { DriveFileWire } from "@klorn/contract";
import { getFile } from "./drive-read.js";
import {
  DRIVE_ID_MAX_CHARS,
  klornDriveSource,
  updateDriveFileRow,
  upsertDriveFileRow,
} from "./drive-rows.js";
import { DRIVE_PROVIDER_ENABLED, type DriveProviderEnabledMap } from "./drive-scope.js";
import {
  findKlornFolder,
  findOwnDriveRow,
  type KlornItem,
  listKlornChildren,
} from "./klorn-drive-read.js";
import { KlornDriveError } from "./klorn-errors.js";
import { cleanKlornFileName } from "./klorn-file-name.js";

/** The deepest a folder may sit; a folder at the root is depth 1. */
export const DRIVE_MAX_FOLDER_DEPTH = 32;
/** The most rows one downward walk (a folder's height, a folder delete) reads. */
export const DRIVE_FOLDER_WALK_MAX_ITEMS = 1000;

/**
 * The folder chain from `folderExternalId` up to the root, nearest first. A
 * folder missing on the way up (deleted meanwhile) ends the chain like the root.
 */
async function ancestorChain(
  userId: string,
  folderExternalId: string,
  providerEnabled: DriveProviderEnabledMap,
): Promise<string[]> {
  const chain: string[] = [];
  let current: string | null = folderExternalId;
  while (current !== null) {
    if (chain.length >= DRIVE_MAX_FOLDER_DEPTH) throw new KlornDriveError("too-deep");
    const folder = await findKlornFolder(userId, current, providerEnabled);
    if (folder === null) break;
    chain.push(folder.externalId);
    current = folder.parentExternalId;
  }
  return chain;
}

/** How many folder levels a folder spans, itself included (1 without subfolders). */
async function folderHeight(
  userId: string,
  folderExternalId: string,
  providerEnabled: DriveProviderEnabledMap,
): Promise<number> {
  const seen = new Set([folderExternalId]);
  let frontier = [folderExternalId];
  let height = 1;
  for (;;) {
    const take = DRIVE_FOLDER_WALK_MAX_ITEMS - seen.size + 2;
    const children = await listKlornChildren(
      userId,
      frontier,
      { foldersOnly: true, take },
      providerEnabled,
    );
    // A folder already counted (a cycle two racing moves left) is not walked again.
    const fresh = children.filter((child) => !seen.has(child.externalId));
    if (fresh.length === 0) return height;
    for (const child of fresh) seen.add(child.externalId);
    if (seen.size - 1 > DRIVE_FOLDER_WALK_MAX_ITEMS) throw new KlornDriveError("folder-too-large");
    height += 1;
    if (height > DRIVE_MAX_FOLDER_DEPTH) throw new KlornDriveError("too-deep");
    frontier = fresh.map((child) => child.externalId);
  }
}

/** The parent folder's id, checked to be a folder of this user's Klorn drive; null for the root. */
export async function resolveKlornParent(
  userId: string,
  raw: unknown,
  providerEnabled: DriveProviderEnabledMap,
): Promise<string | null> {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || raw.length > DRIVE_ID_MAX_CHARS) {
    throw new KlornDriveError("parent-not-found");
  }
  const folder = await findKlornFolder(userId, raw, providerEnabled);
  if (folder === null) throw new KlornDriveError("parent-not-found");
  return folder.externalId;
}

/** A new folder, at the root or in one of the user's folders. */
export async function createKlornFolder(
  userId: string,
  request: { name: unknown; parentExternalId?: unknown },
  providerEnabled: DriveProviderEnabledMap = DRIVE_PROVIDER_ENABLED,
): Promise<DriveFileWire> {
  const name = cleanKlornFileName(request.name);
  if (name === null) throw new KlornDriveError("invalid-name");
  const parent = await resolveKlornParent(userId, request.parentExternalId, providerEnabled);
  if (parent !== null) {
    const depth = (await ancestorChain(userId, parent, providerEnabled)).length;
    if (depth + 1 > DRIVE_MAX_FOLDER_DEPTH) throw new KlornDriveError("too-deep");
  }
  const externalId = randomUUID();
  const written = await upsertDriveFileRow(userId, klornDriveSource(externalId), {
    name,
    modifiedAt: new Date(),
    isFolder: true,
    mimeType: null,
    parentExternalId: parent,
  });
  if (!written.ok) throw new KlornDriveError("invalid-name");
  const folder = await getFile(userId, written.id, providerEnabled);
  if (folder === null) throw new KlornDriveError("not-found");
  return folder;
}

/** The caller's own Klorn row, or the refusal that fits. */
export async function ownKlornItem(
  userId: string,
  id: string,
  providerEnabled: DriveProviderEnabledMap,
): Promise<KlornItem> {
  const row = await findOwnDriveRow(userId, id, providerEnabled);
  if (row === null) throw new KlornDriveError("not-found");
  if (row.kind === "external") throw new KlornDriveError("read-only");
  return row.item;
}

/** Throws unless `item` may move under `parent` (null: the root). */
async function assertMovable(
  userId: string,
  item: KlornItem,
  parent: string | null,
  providerEnabled: DriveProviderEnabledMap,
): Promise<void> {
  if (parent === null) return;
  const chain = await ancestorChain(userId, parent, providerEnabled);
  if (chain.includes(item.externalId)) throw new KlornDriveError("cycle");
  if (!item.isFolder) return;
  const height = await folderHeight(userId, item.externalId, providerEnabled);
  if (chain.length + height > DRIVE_MAX_FOLDER_DEPTH) throw new KlornDriveError("too-deep");
}

/** Rename, move, or both. A field left undefined is left as it is. */
export async function updateKlornItem(
  userId: string,
  id: string,
  request: { name?: unknown; parentExternalId?: unknown },
  providerEnabled: DriveProviderEnabledMap = DRIVE_PROVIDER_ENABLED,
): Promise<DriveFileWire> {
  const item = await ownKlornItem(userId, id, providerEnabled);
  const name = request.name === undefined ? item.name : cleanKlornFileName(request.name);
  if (name === null) throw new KlornDriveError("invalid-name");

  const moving = request.parentExternalId !== undefined;
  let parent = item.parentExternalId;
  if (moving) {
    if (request.parentExternalId === item.externalId) throw new KlornDriveError("cycle");
    parent = await resolveKlornParent(userId, request.parentExternalId, providerEnabled);
    if (parent !== item.parentExternalId) {
      await assertMovable(userId, item, parent, providerEnabled);
    }
  }

  const written = await updateDriveFileRow(userId, klornDriveSource(item.externalId), {
    name,
    modifiedAt: item.modifiedAt,
    ...(moving && { parentExternalId: parent }),
  });
  if (!written.ok) throw new KlornDriveError("invalid-name");
  if (!written.updated) throw new KlornDriveError("not-found");
  const file = await getFile(userId, item.id, providerEnabled);
  if (file === null) throw new KlornDriveError("not-found");
  return file;
}
