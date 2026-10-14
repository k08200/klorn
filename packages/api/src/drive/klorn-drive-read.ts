/**
 * The Klorn drive's own reads (step D3 of docs/providers/unified-platform-plan.md):
 * what its write, download and delete operations need to know about the rows,
 * none of which goes on the wire as is. Same rules as drive/drive-read.ts, and
 * drive-file-guard.test.ts holds this module to them:
 *
 *   - every query names the user, and every list goes through the kill switch
 *     (`driveSourceScope()` inside its AND; `isDriveRowVisible` on a row read by
 *     id), so with any of the three flags off nothing is found;
 *   - every query selects its columns.
 *
 * The storage key IS selected here, for the operations that act on the object;
 * it never leaves the server (the wire shape comes from drive-read.ts).
 *
 * Runs on the global client, like the other drive reads: when the app role drops
 * BYPASSRLS these move to `withTenant` (db-tenant.ts).
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { isDriveFileId } from "./drive-read.js";
import { KLORN_DRIVE_SOURCE_KEY } from "./drive-rows.js";
import {
  DRIVE_PROVIDER_ENABLED,
  type DriveProviderEnabledMap,
  driveSourceScope,
  isDriveRowVisible,
} from "./drive-scope.js";

/** One row of the Klorn drive, as its operations see it. */
export interface KlornItem {
  readonly id: string;
  readonly externalId: string;
  readonly name: string;
  readonly isFolder: boolean;
  readonly parentExternalId: string | null;
  readonly modifiedAt: Date;
  readonly storageKey: string | null;
}

/** A row in a folder walk. */
export interface KlornChild {
  readonly externalId: string;
  readonly isFolder: boolean;
  readonly storageKey: string | null;
}

/** A row read by id: a Klorn item, a visible file of another source, or nothing. */
export type OwnDriveRow =
  | { readonly kind: "klorn"; readonly item: KlornItem }
  | { readonly kind: "external" };

const ITEM_SELECT = {
  id: true,
  provider: true,
  trashed: true,
  externalId: true,
  name: true,
  isFolder: true,
  parentExternalId: true,
  modifiedAt: true,
  storageKey: true,
} as const satisfies Prisma.DriveFileSelect;

const CHILD_SELECT = {
  externalId: true,
  isFolder: true,
  storageKey: true,
} as const satisfies Prisma.DriveFileSelect;

/** The rows of this user's Klorn drive: the user, the provider, the one source. */
function klornRowsOf(userId: string): Prisma.DriveFileWhereInput[] {
  return [{ userId, provider: "KLORN", sourceKey: KLORN_DRIVE_SOURCE_KEY, trashed: false }];
}

/**
 * The caller's own row by id. Null for an unknown id, another user's, a trashed
 * row and a row whose provider is hidden, all alike; `external` for a visible
 * file of another source (read-only in Klorn, decision V4).
 */
export async function findOwnDriveRow(
  userId: string,
  id: string,
  providerEnabled: DriveProviderEnabledMap = DRIVE_PROVIDER_ENABLED,
): Promise<OwnDriveRow | null> {
  if (!isDriveFileId(id)) return null;
  const row = await prisma.driveFile.findUnique({
    where: { id, userId },
    select: ITEM_SELECT,
  });
  if (row === null || row.trashed || !isDriveRowVisible(row, providerEnabled)) return null;
  if (row.provider !== "KLORN") return { kind: "external" };
  const { provider: _provider, trashed: _trashed, ...item } = row;
  return { kind: "klorn", item };
}

/** One folder of the user's Klorn drive by the id D3 minted, or null. */
export async function findKlornFolder(
  userId: string,
  externalId: string,
  providerEnabled: DriveProviderEnabledMap = DRIVE_PROVIDER_ENABLED,
): Promise<{ externalId: string; parentExternalId: string | null } | null> {
  const match = { externalId, isFolder: true };
  return await prisma.driveFile.findFirst({
    where: { AND: [driveSourceScope(providerEnabled), ...klornRowsOf(userId), match] },
    select: { externalId: true, parentExternalId: true },
  });
}

/**
 * The direct children of these folders, at most `take` (the walks pass their
 * bound plus one, to see that it is passed). `foldersOnly` for the depth walk.
 */
export async function listKlornChildren(
  userId: string,
  parentExternalIds: readonly string[],
  options: { foldersOnly: boolean; take: number },
  providerEnabled: DriveProviderEnabledMap = DRIVE_PROVIDER_ENABLED,
): Promise<KlornChild[]> {
  if (parentExternalIds.length === 0) return [];
  const match: Prisma.DriveFileWhereInput[] = [
    { parentExternalId: { in: [...parentExternalIds] } },
    ...(options.foldersOnly ? [{ isFolder: true }] : []),
  ];
  return await prisma.driveFile.findMany({
    where: { AND: [driveSourceScope(providerEnabled), ...klornRowsOf(userId), ...match] },
    orderBy: [{ id: "asc" }],
    take: options.take,
    select: CHILD_SELECT,
  });
}

/** The bytes the user's Klorn files hold, from their recorded sizes (P3's usage). */
export async function klornUsageBytes(
  userId: string,
  providerEnabled: DriveProviderEnabledMap = DRIVE_PROVIDER_ENABLED,
): Promise<number> {
  const result = await prisma.driveFile.aggregate({
    where: { AND: [driveSourceScope(providerEnabled), ...klornRowsOf(userId)] },
    _sum: { sizeBytes: true },
  });
  return Number(result._sum.sizeBytes ?? 0n);
}
