/**
 * The one drive read path (step D2 of docs/providers/unified-platform-plan.md):
 * the list, the name search and the by-id read every drive surface uses.
 *
 * Each read
 *   - is scoped to one user in the query itself;
 *   - goes through the kill switch (drive/drive-scope.ts): `driveSourceScope()`
 *     in the `where` of a list, `isDriveRowVisible` on a row fetched by id;
 *   - skips trashed rows;
 *   - is paged on (modifiedAt, id), newest first, with a hard ceiling;
 *   - returns the wire shape, never a raw row: no storage key leaves the
 *     database, and `sizeBytes` (a BigInt, which JSON.stringify refuses) is a
 *     number. `readOnly` is derived from the provider (decision V4), not read
 *     from the row.
 *
 * The search matches NAMES only, with ILIKE inside one user's rows: Prisma's
 * `contains`, so the text is a bind parameter, never SQL. It is not trigram:
 * a user's index is small, pg_trgm would need an extension in the migration, and
 * whether its index helps a Korean name depends on the database's locale, which
 * is not measured. A trigram index can be added later without changing this API,
 * and one (or a prefix index) is needed before a source brings many rows (D7).
 * drive-file-guard.test.ts fails for a DriveFile read anywhere else.
 *
 * These reads run on the global client. The table has row-level security; it is
 * inert while the app role has BYPASSRLS, and when that role is dropped the reads
 * move to `withTenant` (db-tenant.ts), or they return no row.
 */

import type { DriveFileWire } from "@klorn/contract";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { safeHttpsLink } from "../safe-https-link.js";
import { type DriveProviderName, isReadOnlyDriveProvider } from "./drive-providers.js";
import {
  DRIVE_PROVIDER_ENABLED,
  type DriveProviderEnabledMap,
  driveSourceScope,
  isDriveRowVisible,
} from "./drive-scope.js";

/** Files per page when the caller names no limit. */
export const DRIVE_PAGE_DEFAULT = 50;
/** The most files one page ever holds, whatever the caller asks for. */
export const DRIVE_PAGE_MAX = 100;
/** The most characters of a search text that are used. */
export const DRIVE_SEARCH_MAX_CHARS = 100;

/** The longest cursor accepted; the route's schema uses the same bound. */
export const DRIVE_CURSOR_MAX_CHARS = 200;
const CURSOR_SEPARATOR = "|";
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** What a DriveFile id can look like (a uuid): checked before any query. */
const DRIVE_FILE_ID = /^[A-Za-z0-9-]{1,64}$/;
const CONTROL_CHARACTERS = /\p{Cc}/gu;
const LIKE_SPECIAL = /[\\%_]/g;

/** The columns the wire shape is built from. The storage key is not among them. */
export const DRIVE_WIRE_SELECT = {
  id: true,
  provider: true,
  sourceKey: true,
  externalId: true,
  name: true,
  mimeType: true,
  isFolder: true,
  sizeBytes: true,
  parentExternalId: true,
  modifiedAt: true,
  webUrl: true,
} as const satisfies Prisma.DriveFileSelect;

type DriveWireRow = Prisma.DriveFileGetPayload<{ select: typeof DRIVE_WIRE_SELECT }>;

/** Where a page starts: strictly after this row in (modifiedAt, id) descending order. */
export interface DriveCursor {
  readonly modifiedAt: Date;
  readonly id: string;
}

export interface DriveListOptions {
  readonly userId: string;
  readonly limit?: number;
  readonly cursor?: DriveCursor;
  readonly provider?: DriveProviderName;
  readonly sourceKey?: string;
}

export interface DriveSearchOptions extends DriveListOptions {
  readonly text: string;
}

export interface DrivePage {
  readonly files: DriveFileWire[];
  readonly nextCursor: string | null;
}

const EMPTY_PAGE: DrivePage = { files: [], nextCursor: null };

export function isDriveFileId(value: unknown): value is string {
  return typeof value === "string" && DRIVE_FILE_ID.test(value);
}

/** The row as the wire carries it. A stored link is checked again on the way out. */
export function toDriveFileWire(row: DriveWireRow): DriveFileWire {
  return {
    id: row.id,
    provider: row.provider,
    sourceKey: row.sourceKey,
    externalId: row.externalId,
    name: row.name,
    mimeType: row.mimeType,
    isFolder: row.isFolder,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    parentExternalId: row.parentExternalId,
    modifiedAt: row.modifiedAt.toISOString(),
    webUrl: safeHttpsLink(row.webUrl),
    readOnly: isReadOnlyDriveProvider(row.provider),
  };
}

export function encodeDriveCursor(cursor: DriveCursor): string {
  const text = `${cursor.modifiedAt.toISOString()}${CURSOR_SEPARATOR}${cursor.id}`;
  return Buffer.from(text, "utf8").toString("base64url");
}

/** The cursor a client sent back, or null when it is not one this module made. */
export function decodeDriveCursor(raw: unknown): DriveCursor | null {
  if (typeof raw !== "string" || raw.length > DRIVE_CURSOR_MAX_CHARS || !BASE64URL.test(raw))
    return null;
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const at = text.indexOf(CURSOR_SEPARATOR);
  if (at < 0) return null;
  const iso = text.slice(0, at);
  const id = text.slice(at + 1);
  if (!ISO_INSTANT.test(iso) || !isDriveFileId(id)) return null;
  const modifiedAt = new Date(iso);
  // A well-shaped string that is no instant (month 13) parses to NaN or to another day.
  if (Number.isNaN(modifiedAt.getTime()) || modifiedAt.toISOString() !== iso) return null;
  return { modifiedAt, id };
}

/**
 * The text a search runs on: composed (NFC, as names are stored), without
 * control characters, trimmed, at most DRIVE_SEARCH_MAX_CHARS characters. Null
 * when nothing is left to match on.
 */
export function normaliseDriveSearchText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(CONTROL_CHARACTERS, "").normalize("NFC").trim();
  const capped = [...cleaned].slice(0, DRIVE_SEARCH_MAX_CHARS).join("").trim();
  return capped.length > 0 ? capped : null;
}

/**
 * Prisma sends `contains` as LIKE '%value%' without escaping, so `%` and `_` in
 * the value would be wildcards. Escaped, they are the characters themselves.
 */
export function escapeLikePattern(text: string): string {
  return text.replace(LIKE_SPECIAL, "\\$&");
}

function pageLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isInteger(requested) || requested < 1) {
    return DRIVE_PAGE_DEFAULT;
  }
  return Math.min(requested, DRIVE_PAGE_MAX);
}

/** The caller's own narrowing, each as its own AND member so none can replace the scope. */
function filtersOf(options: DriveListOptions): Prisma.DriveFileWhereInput[] {
  const filters: Prisma.DriveFileWhereInput[] = [{ userId: options.userId, trashed: false }];
  if (options.provider !== undefined) filters.push({ provider: options.provider });
  if (options.sourceKey !== undefined) filters.push({ sourceKey: options.sourceKey });
  const cursor = options.cursor;
  if (cursor !== undefined) {
    filters.push({
      OR: [
        { modifiedAt: { lt: cursor.modifiedAt } },
        { modifiedAt: cursor.modifiedAt, id: { lt: cursor.id } },
      ],
    });
  }
  return filters;
}

function toPage(rows: DriveWireRow[], limit: number): DrivePage {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const more = rows.length > limit && last !== undefined;
  return {
    files: page.map(toDriveFileWire),
    nextCursor: more ? encodeDriveCursor({ modifiedAt: last.modifiedAt, id: last.id }) : null,
  };
}

/** One page of the user's files, newest first. */
export async function listFiles(
  options: DriveListOptions,
  providerEnabled: DriveProviderEnabledMap = DRIVE_PROVIDER_ENABLED,
): Promise<DrivePage> {
  const limit = pageLimit(options.limit);
  const rows = await prisma.driveFile.findMany({
    where: { AND: [driveSourceScope(providerEnabled), ...filtersOf(options)] },
    orderBy: [{ modifiedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: DRIVE_WIRE_SELECT,
  });
  return toPage(rows, limit);
}

/** One page of the user's files whose name contains the text, newest first. */
export async function searchFiles(
  options: DriveSearchOptions,
  providerEnabled: DriveProviderEnabledMap = DRIVE_PROVIDER_ENABLED,
): Promise<DrivePage> {
  const text = normaliseDriveSearchText(options.text);
  if (text === null) return EMPTY_PAGE;
  const limit = pageLimit(options.limit);
  const name = { contains: escapeLikePattern(text), mode: "insensitive" } as const;
  const rows = await prisma.driveFile.findMany({
    where: { AND: [driveSourceScope(providerEnabled), ...filtersOf(options), { name }] },
    orderBy: [{ modifiedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: DRIVE_WIRE_SELECT,
  });
  return toPage(rows, limit);
}

/**
 * One file's metadata, or null: an unknown id, another user's, a trashed file and
 * a file whose provider is disabled are all the same answer.
 */
export async function getFile(
  userId: string,
  id: string,
  providerEnabled: DriveProviderEnabledMap = DRIVE_PROVIDER_ENABLED,
): Promise<DriveFileWire | null> {
  if (!isDriveFileId(id)) return null;
  const row = await prisma.driveFile.findUnique({
    where: { id, userId },
    select: { ...DRIVE_WIRE_SELECT, trashed: true },
  });
  if (row === null || row.trashed || !isDriveRowVisible(row, providerEnabled)) return null;
  return toDriveFileWire(row);
}
