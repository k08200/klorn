/**
 * The drive part of the user's data export (GET /api/user/me/export; step D2 of
 * docs/providers/unified-platform-plan.md).
 *
 * It mirrors what the export does for calendar events: EVERY row the system
 * holds for the user, trashed ones and the rows of a disabled provider included.
 * That is why it is exempt from the kill switch (drive-file-guard.test.ts names
 * this module); a flag hides a row from the product, not from its owner's
 * export. It is metadata, like the table. The storage key is left out: it is the
 * address of an object in Klorn's storage, not data about the user.
 */

import type { DriveFileWire } from "@klorn/contract";
import { prisma } from "../db.js";
import { DRIVE_WIRE_SELECT, toDriveFileWire } from "./drive-read.js";

export interface DriveFileExport extends DriveFileWire {
  trashed: boolean;
  /** The source's own version of the file, as the index holds it. */
  etag: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function exportDriveFiles(userId: string): Promise<DriveFileExport[]> {
  const rows = await prisma.driveFile.findMany({
    where: { userId },
    orderBy: [{ modifiedAt: "desc" }, { id: "desc" }],
    select: {
      ...DRIVE_WIRE_SELECT,
      trashed: true,
      etag: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return rows.map((row) => ({
    ...toDriveFileWire(row),
    trashed: row.trashed,
    etag: row.etag,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}
