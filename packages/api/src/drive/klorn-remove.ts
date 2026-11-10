/**
 * Download and delete in the Klorn drive (step D3 of
 * docs/providers/unified-platform-plan.md). Both act on the object through
 * `getUserStorage()`, which refuses a key outside the user's prefix, after the
 * row was found under the user's own id.
 *
 * Download: a signed link (D1), minted per request and valid for
 * KLORN_DOWNLOAD_URL_TTL_SECONDS; it always downloads as an octet-stream
 * attachment under the file's cleaned name. A folder has no bytes.
 *
 * Delete is permanent (no trash) and always object first, row second:
 *
 *   - a file: its object, then its row. If the object cannot be deleted, the row
 *     stays and the request may be sent again.
 *   - a folder: everything under it, bounded (DRIVE_FOLDER_WALK_MAX_ITEMS rows,
 *     DRIVE_MAX_FOLDER_DEPTH levels; past either the request is refused and
 *     nothing is deleted). Objects go in batches of DRIVE_DELETE_CONCURRENCY,
 *     stopping at the first batch with a failure; then the rows of the files
 *     whose objects are gone. Only when every object is gone do the folder rows
 *     go. A partial delete answers `storage-unavailable` and is continued by
 *     sending the same request again.
 */

import { captureError } from "../sentry.js";
import { StorageError } from "../storage/errors.js";
import { getUserStorage } from "../storage/runtime.js";
import type { UserStorage } from "../storage/user-storage.js";
import { deleteKlornDriveRows } from "./drive-rows.js";
import { type DriveProviderEnabledMap, driveProvidersFor } from "./drive-scope.js";
import { type KlornChild, listKlornChildren } from "./klorn-drive-read.js";
import { KlornDriveError } from "./klorn-errors.js";
import { DRIVE_FOLDER_WALK_MAX_ITEMS, DRIVE_MAX_FOLDER_DEPTH, ownKlornItem } from "./klorn-tree.js";

/**
 * How long a download link lives. The client follows it at once; the signature
 * is checked when the request starts, not while the bytes flow, so a large file
 * still downloads. Well under D1's 300 s cap, because a link that leaks (a log,
 * a history entry) should not outlive the click.
 */
export const KLORN_DOWNLOAD_URL_TTL_SECONDS = 60;
/** Object deletes in flight at once for a folder (D1's purge uses the same). */
export const DRIVE_DELETE_CONCURRENCY = 8;

export interface KlornDeleteResult {
  files: number;
  folders: number;
}

async function storageOrUnavailable(): Promise<UserStorage> {
  const storage = await getUserStorage();
  if (!storage) throw new KlornDriveError("storage-unavailable");
  return storage;
}

function storageFailure(err: unknown): unknown {
  if (!(err instanceof StorageError)) return err;
  return new KlornDriveError("storage-unavailable", { retryable: err.retryable, cause: err });
}

/** A signed link to one of the user's files. */
export async function klornDownloadLink(
  userId: string,
  id: string,
  providerEnabled: DriveProviderEnabledMap = driveProvidersFor(userId),
): Promise<{ url: string; expiresInSeconds: number }> {
  const item = await ownKlornItem(userId, id, providerEnabled);
  if (item.isFolder) throw new KlornDriveError("is-folder");
  if (item.storageKey === null) throw new KlornDriveError("not-found");
  const storage = await storageOrUnavailable();
  try {
    return await storage.signedDownloadUrl(userId, item.storageKey, {
      expiresInSeconds: KLORN_DOWNLOAD_URL_TTL_SECONDS,
      downloadName: item.name,
    });
  } catch (err) {
    throw storageFailure(err);
  }
}

/** Every row under the folder, level by level, within both bounds. */
async function subtreeOf(
  userId: string,
  folderExternalId: string,
  providerEnabled: DriveProviderEnabledMap,
): Promise<KlornChild[]> {
  const rows: KlornChild[] = [];
  // A cycle cannot be written through D3, but two moves racing each other could
  // leave one; a row already seen is not walked again, so the folder still goes.
  const seen = new Set([folderExternalId]);
  let frontier = [folderExternalId];
  for (let depth = 1; frontier.length > 0; depth++) {
    if (depth > DRIVE_MAX_FOLDER_DEPTH) throw new KlornDriveError("too-deep");
    const take = DRIVE_FOLDER_WALK_MAX_ITEMS - rows.length + 1;
    const level = await listKlornChildren(
      userId,
      frontier,
      { foldersOnly: false, take },
      providerEnabled,
    );
    const fresh = level.filter((row) => !seen.has(row.externalId));
    for (const row of fresh) seen.add(row.externalId);
    rows.push(...fresh);
    if (rows.length > DRIVE_FOLDER_WALK_MAX_ITEMS) throw new KlornDriveError("folder-too-large");
    frontier = fresh.filter((row) => row.isFolder).map((row) => row.externalId);
  }
  return rows;
}

/**
 * Delete the files' objects, DRIVE_DELETE_CONCURRENCY at a time. Answers the
 * files whose objects are gone, and the first failure (then it stopped).
 */
async function deleteObjects(
  storage: UserStorage,
  userId: string,
  files: readonly KlornChild[],
): Promise<{ gone: string[]; failure: unknown }> {
  const gone: string[] = [];
  for (let start = 0; start < files.length; start += DRIVE_DELETE_CONCURRENCY) {
    const batch = files.slice(start, start + DRIVE_DELETE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        if (file.storageKey !== null) await storage.delete(userId, file.storageKey);
        return file.externalId;
      }),
    );
    for (const result of results) if (result.status === "fulfilled") gone.push(result.value);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) return { gone, failure: failed.reason };
  }
  return { gone, failure: null };
}

/**
 * After a partial folder delete: the rows of the files whose objects are gone.
 * A failure here is reported and does not replace the storage error the person
 * must see; the rows left point at deleted objects until the delete is sent again.
 */
async function deleteRowsOfGoneFiles(userId: string, gone: readonly string[]): Promise<void> {
  try {
    await deleteKlornDriveRows(userId, gone);
  } catch (err) {
    console.error(`[DRIVE] partial folder delete could not remove its rows for user ${userId}`);
    captureError(err, { tags: { scope: "drive.delete.rows" }, extra: { userId } });
  }
}

/** Delete one file, or one folder with everything in it. See the header. */
export async function deleteKlornItem(
  userId: string,
  id: string,
  providerEnabled: DriveProviderEnabledMap = driveProvidersFor(userId),
): Promise<KlornDeleteResult> {
  const item = await ownKlornItem(userId, id, providerEnabled);
  const storage = await storageOrUnavailable();
  if (!item.isFolder) {
    const { failure } = await deleteObjects(storage, userId, [item]);
    if (failure) throw storageFailure(failure);
    const deleted = await deleteKlornDriveRows(userId, [item.externalId]);
    if (deleted === 0) throw new KlornDriveError("not-found");
    return { files: 1, folders: 0 };
  }
  const subtree = await subtreeOf(userId, item.externalId, providerEnabled);
  const files = subtree.filter((row) => !row.isFolder);
  const { gone, failure } = await deleteObjects(storage, userId, files);
  if (failure) {
    await deleteRowsOfGoneFiles(userId, gone);
    throw storageFailure(failure);
  }
  const folders = subtree.filter((row) => row.isFolder).map((row) => row.externalId);
  await deleteKlornDriveRows(userId, [...gone, ...folders, item.externalId]);
  return { files: files.length, folders: folders.length + 1 };
}
