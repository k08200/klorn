/**
 * The one place a DriveFile row is written (step D2 of
 * docs/providers/unified-platform-plan.md; mirrors pim/calendar-rows.ts).
 *
 * A row is METADATA of one file or folder of one source. Every writer states the
 * source (provider, sourceKey, externalId) through the builders here, and every
 * value an external drive sent goes through `driveRowData` first: the name, the
 * link, the type and the size are written by whoever shared the file, not by the
 * user. drive-file-guard.test.ts fails for a write anywhere else.
 *
 * An update is partial. A field the input does not name (it is `undefined`) is
 * left as it is in the row; a field it names is written, an explicit `null`
 * included. So a rename cannot turn a folder into a file, move it, or bring it
 * back from the trash. Creating a row needs the name and the modified time; the
 * rest starts from the defaults below.
 *
 * `parentExternalId` NULL means "no known parent row": the source's root, OR a
 * parent that was never indexed (a file picked through the Google Picker under
 * drive.file reports a parent the user never picked). It does not mean "at the
 * root", so an external source's root listing is not `parentExternalId IS NULL`.
 *
 * What plugs in: D3 (the Klorn drive) and D7 (device import, into the Klorn
 * drive) write KLORN rows, with a storage key; D5 (Google Drive) and D6
 * (OneDrive) write the rows of files that stay in their service, with a link and
 * no storage key. A connector must check that the `sourceKey` it writes is an
 * account of that user before it calls this.
 */

import { prisma } from "../db.js";
import { safeHttpsLink } from "../safe-https-link.js";
import { type DriveProviderName, isKlornDriveProvider } from "./drive-providers.js";

/** Every provider but the Klorn drive itself: its rows name the account they came from. */
export type ConnectedDriveProvider = Exclude<DriveProviderName, "KLORN">;

/** `sourceKey` of a user's Klorn drive: each user has exactly one. */
export const KLORN_DRIVE_SOURCE_KEY = "klorn";

/** The longest source key, upstream id, parent id or etag stored. */
export const DRIVE_ID_MAX_CHARS = 512;
/** The longest name stored, in characters. */
export const DRIVE_NAME_MAX_CHARS = 500;
const DRIVE_STORAGE_KEY_MAX_CHARS = 1024;

const CONTROL_CHARACTER = /\p{Cc}/u;
/** Control characters, and the bidi embeddings, overrides and isolates that can disguise an extension. */
const UNSAFE_NAME_CHARACTERS = /[\p{Cc}‪-‮⁦-⁩]/gu;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** Which file of which source a row is. */
export interface DriveFileSource {
  readonly provider: DriveProviderName;
  /** 'klorn', or a connector's account id. */
  readonly sourceKey: string;
  /** The id in the source. */
  readonly externalId: string;
}

/** A file in the user's Klorn drive (D3, D7). `externalId` is the id D3 minted for it. */
export function klornDriveSource(externalId: string): DriveFileSource {
  return { provider: "KLORN", sourceKey: KLORN_DRIVE_SOURCE_KEY, externalId };
}

/** A file of a connected account (D5, D6). */
export function connectedDriveSource(
  provider: ConnectedDriveProvider,
  sourceKey: string,
  externalId: string,
): DriveFileSource {
  return { provider, sourceKey, externalId };
}

/**
 * What a source reported about a file, before any cleaning. A field left out is
 * "not reported": an existing row keeps its value. `null` is "the source says
 * there is none".
 */
export interface DriveFileInput {
  readonly name: string;
  readonly modifiedAt: Date;
  readonly mimeType?: string | null;
  readonly isFolder?: boolean;
  readonly sizeBytes?: number | bigint | null;
  /** The containing folder's id in the same source; null when no parent is known. */
  readonly parentExternalId?: string | null;
  /** External sources only; anything but an https link is dropped. */
  readonly webUrl?: string | null;
  /** Klorn-held bytes only (D1's key). */
  readonly storageKey?: string;
  /** The source's own version of the file: an etag, a version, a content fingerprint. Opaque. */
  readonly etag?: string | null;
  readonly trashed?: boolean;
}

/** What the input names, cleaned: exactly what an update writes. Never the identity. */
export interface DriveRowChanges {
  readonly name: string;
  readonly modifiedAt: Date;
  readonly mimeType?: string | null;
  readonly isFolder?: boolean;
  readonly sizeBytes?: bigint | null;
  readonly parentExternalId?: string | null;
  readonly webUrl?: string | null;
  readonly storageKey?: string;
  readonly etag?: string | null;
  readonly trashed?: boolean;
}

/** The whole row a create writes: the identity, the defaults, and the changes over them. */
export interface DriveRowData {
  readonly userId: string;
  readonly provider: DriveProviderName;
  readonly sourceKey: string;
  readonly externalId: string;
  readonly name: string;
  readonly modifiedAt: Date;
  readonly mimeType: string | null;
  readonly isFolder: boolean;
  readonly sizeBytes: bigint | null;
  readonly parentExternalId: string | null;
  readonly webUrl: string | null;
  readonly storageKey: string | null;
  readonly etag: string | null;
  readonly trashed: boolean;
}

/** What a new row holds for every field its source did not report. */
const CREATE_DEFAULTS = {
  mimeType: null,
  isFolder: false,
  sizeBytes: null,
  parentExternalId: null,
  webUrl: null,
  storageKey: null,
  etag: null,
  trashed: false,
} as const;

/** Why a row was not written: which part of it could not be stored. Never echoes a value. */
export type DriveRowRefusal = "identity" | "name" | "modifiedAt" | "storageKey";

export type DriveRowDataResult =
  | { readonly ok: true; readonly data: DriveRowData; readonly changes: DriveRowChanges }
  | { readonly ok: false; readonly reason: DriveRowRefusal };

export type DriveRowWriteResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: DriveRowRefusal };

function isBoundedText(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxChars &&
    !CONTROL_CHARACTER.test(value)
  );
}

/**
 * The name as stored: no control or bidi-override characters, composed (NFC, so a
 * name typed on a Mac and a search for it meet), trimmed, at most
 * DRIVE_NAME_MAX_CHARS characters. Null when nothing is left.
 */
export function cleanDriveName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(UNSAFE_NAME_CHARACTERS, "").normalize("NFC").trim();
  const capped = [...cleaned].slice(0, DRIVE_NAME_MAX_CHARS).join("").trimEnd();
  return capped.length > 0 ? capped : null;
}

function cleanMediaType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lowered = value.trim().toLowerCase();
  return MEDIA_TYPE.test(lowered) ? lowered : null;
}

/** A whole, non-negative byte count that a JSON number can carry exactly; else null. */
function cleanSizeBytes(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? value : null;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? BigInt(value)
    : null;
}

function cleanEtag(value: unknown): string | null {
  return isBoundedText(value, DRIVE_ID_MAX_CHARS) ? value : null;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/** A folder has no size, whatever was reported; otherwise the size only when the input names one. */
function sizeChange(input: DriveFileInput): { sizeBytes?: bigint | null } {
  if (input.isFolder === true) return { sizeBytes: null };
  return input.sizeBytes === undefined ? {} : { sizeBytes: cleanSizeBytes(input.sizeBytes) };
}

/** The fields the input names, cleaned; a field it leaves out is absent here too. */
function changesOf(input: DriveFileInput, name: string, klornHeld: boolean): DriveRowChanges {
  return {
    name,
    modifiedAt: input.modifiedAt,
    ...(input.mimeType !== undefined && { mimeType: cleanMediaType(input.mimeType) }),
    ...(input.isFolder !== undefined && { isFolder: input.isFolder === true }),
    ...sizeChange(input),
    ...(input.parentExternalId !== undefined && { parentExternalId: input.parentExternalId }),
    // The rule every link Klorn hands on passes (safe-https-link.ts): absolute
    // https, no credentials, bounded. A Klorn-held file has no link of its own.
    ...(input.webUrl !== undefined && { webUrl: klornHeld ? null : safeHttpsLink(input.webUrl) }),
    ...(input.storageKey !== undefined && { storageKey: input.storageKey }),
    ...(input.etag !== undefined && { etag: cleanEtag(input.etag) }),
    ...(input.trashed !== undefined && { trashed: input.trashed === true }),
  };
}

/**
 * The row a source's report becomes (`data`, for a create) and the part of it
 * the report names (`changes`, for an update), or the part that cannot be
 * stored. Pure: the same cleaning serves every writer and the tests.
 */
export function driveRowData(
  userId: string,
  source: DriveFileSource,
  input: DriveFileInput,
): DriveRowDataResult {
  const parent = input.parentExternalId ?? null;
  if (
    !isBoundedText(source.sourceKey, DRIVE_ID_MAX_CHARS) ||
    !isBoundedText(source.externalId, DRIVE_ID_MAX_CHARS) ||
    (parent !== null && !isBoundedText(parent, DRIVE_ID_MAX_CHARS))
  ) {
    return { ok: false, reason: "identity" };
  }
  const name = cleanDriveName(input.name);
  if (name === null) return { ok: false, reason: "name" };
  if (!isValidDate(input.modifiedAt)) return { ok: false, reason: "modifiedAt" };

  const klornHeld = isKlornDriveProvider(source.provider);
  if (
    input.storageKey !== undefined &&
    (!klornHeld || !isBoundedText(input.storageKey, DRIVE_STORAGE_KEY_MAX_CHARS))
  ) {
    return { ok: false, reason: "storageKey" };
  }

  const changes = changesOf(input, name, klornHeld);
  const data: DriveRowData = {
    ...CREATE_DEFAULTS,
    userId,
    provider: source.provider,
    sourceKey: source.sourceKey,
    externalId: source.externalId,
    ...changes,
  };
  return { ok: true, data, changes };
}

/**
 * Create the row of this file, or bring it up to date. A create writes the whole
 * row; an update writes only what the input names, and never the identity.
 */
export async function upsertDriveFileRow(
  userId: string,
  source: DriveFileSource,
  input: DriveFileInput,
): Promise<DriveRowWriteResult> {
  const row = driveRowData(userId, source, input);
  if (!row.ok) return row;
  const { provider, sourceKey, externalId } = row.data;
  const written = await prisma.driveFile.upsert({
    where: { driveFileIdentity: { userId, provider, sourceKey, externalId } },
    create: row.data,
    update: row.changes,
    select: { id: true },
  });
  return { ok: true, id: written.id };
}
