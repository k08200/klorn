/**
 * The drive row a summary is made from (step D4 of
 * docs/providers/unified-platform-plan.md). Same rules as every drive read
 * (drive-file-guard.test.ts): the query names the user, the row goes through the
 * kill switch (`isDriveRowVisible`), the columns are selected. A trashed row, a
 * row whose provider is hidden and another user's row are all null.
 *
 * The storage key is selected for the byte read and never leaves the server.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import type { DriveProviderName } from "./drive-providers.js";
import { isDriveFileId } from "./drive-read.js";
import {
  type DriveProviderEnabledMap,
  driveProvidersFor,
  isDriveRowVisible,
} from "./drive-scope.js";

export interface SummarySource {
  readonly id: string;
  readonly provider: DriveProviderName;
  readonly sourceKey: string;
  readonly externalId: string;
  readonly name: string;
  readonly mimeType: string | null;
  readonly isFolder: boolean;
  readonly sizeBytes: number | null;
  readonly storageKey: string | null;
  readonly etag: string | null;
}

const SOURCE_SELECT = {
  id: true,
  provider: true,
  sourceKey: true,
  externalId: true,
  name: true,
  mimeType: true,
  isFolder: true,
  sizeBytes: true,
  storageKey: true,
  etag: true,
  trashed: true,
} as const satisfies Prisma.DriveFileSelect;

/** The user's visible, untrashed file by id, as a summary needs it; null otherwise. */
export async function findSummarySource(
  userId: string,
  id: string,
  providerEnabled: DriveProviderEnabledMap = driveProvidersFor(userId),
): Promise<SummarySource | null> {
  if (!isDriveFileId(id)) return null;
  const row = await prisma.driveFile.findUnique({
    where: { id, userId },
    select: SOURCE_SELECT,
  });
  if (row === null || row.trashed || !isDriveRowVisible(row, providerEnabled)) return null;
  const { trashed: _trashed, sizeBytes, ...rest } = row;
  return { ...rest, sizeBytes: sizeBytes === null ? null : Number(sizeBytes) };
}
