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
 * What plugs in: D3 (the Klorn drive) and D7 (device import) write rows whose
 * bytes Klorn holds, with a storage key; D5 (Google Drive) and D6 (OneDrive) write
 * the rows of files that stay in their service, with a link and no storage key.
 */

import { prisma } from "../db.js";
import { safeMeetingLink } from "../pim/meeting-link.js";
import type { DriveProviderName } from "./drive-providers.js";

/** Every provider but the Klorn drive itself: its rows name the account or device they came from. */
export type ConnectedDriveProvider = Exclude<DriveProviderName, "KLORN">;

/**
 * The providers whose bytes Klorn holds in object storage (D1): only they carry a
 * storage key. Every other provider's files stay in their own service and are
 * read-only from Klorn (decision V4). The migration's CHECK names the same two.
 */
const KLORN_HELD: readonly DriveProviderName[] = ["KLORN", "DEVICE"];

/** `sourceKey` of a user's Klorn drive: each user has exactly one. */
export const KLORN_DRIVE_SOURCE_KEY = "klorn";

/** The longest source key, upstream id or parent id stored. */
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
  /** 'klorn', a connector's account id, or a device source key. */
  readonly sourceKey: string;
  /** The id in the source. */
  readonly externalId: string;
}

/** A file in the user's Klorn drive (D3). `externalId` is the id D3 minted for it. */
export function klornDriveSource(externalId: string): DriveFileSource {
  return { provider: "KLORN", sourceKey: KLORN_DRIVE_SOURCE_KEY, externalId };
}

/** A file of a connected account (D5, D6) or of a device source (D7). */
export function connectedDriveSource(
  provider: ConnectedDriveProvider,
  sourceKey: string,
  externalId: string,
): DriveFileSource {
  return { provider, sourceKey, externalId };
}

/** What a source reported about a file, before any cleaning. */
export interface DriveFileInput {
  readonly name: string;
  readonly modifiedAt: Date;
  readonly mimeType?: string | null;
  readonly isFolder?: boolean;
  readonly sizeBytes?: number | bigint | null;
  /** The containing folder's id in the same source; absent or null at the root. */
  readonly parentExternalId?: string | null;
  /** External sources only; anything but an https link is dropped. */
  readonly webUrl?: string | null;
  /** Klorn-held bytes only (D1's key). Absent on an update leaves the stored key alone. */
  readonly storageKey?: string;
  readonly readOnly?: boolean;
  readonly trashed?: boolean;
}

/** The cleaned row, ready for Prisma. */
export interface DriveRowData {
  readonly userId: string;
  readonly provider: DriveProviderName;
  readonly sourceKey: string;
  readonly externalId: string;
  readonly name: string;
  readonly mimeType: string | null;
  readonly isFolder: boolean;
  readonly sizeBytes: bigint | null;
  readonly parentExternalId: string | null;
  readonly modifiedAt: Date;
  readonly webUrl: string | null;
  readonly storageKey: string | undefined;
  readonly readOnly: boolean;
  readonly trashed: boolean;
}

/** Why a row was not written: which part of it could not be stored. Never echoes a value. */
export type DriveRowRefusal = "identity" | "name" | "modifiedAt" | "storageKey";

export type DriveRowDataResult =
  | { readonly ok: true; readonly data: DriveRowData }
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

function isKlornHeld(provider: DriveProviderName): boolean {
  return KLORN_HELD.includes(provider);
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

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * The row a source's report becomes, or the part of it that cannot be stored.
 * Pure: the same cleaning serves every writer and the tests.
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

  const klornHeld = isKlornHeld(source.provider);
  if (
    input.storageKey !== undefined &&
    (!klornHeld || !isBoundedText(input.storageKey, DRIVE_STORAGE_KEY_MAX_CHARS))
  ) {
    return { ok: false, reason: "storageKey" };
  }
  const isFolder = input.isFolder === true;

  return {
    ok: true,
    data: {
      userId,
      provider: source.provider,
      sourceKey: source.sourceKey,
      externalId: source.externalId,
      name,
      mimeType: cleanMediaType(input.mimeType),
      isFolder,
      sizeBytes: isFolder ? null : cleanSizeBytes(input.sizeBytes),
      parentExternalId: parent,
      modifiedAt: input.modifiedAt,
      // The rule every link Klorn hands on passes (pim/meeting-link.ts): absolute
      // https, no credentials, bounded. A Klorn-held file has no link of its own.
      webUrl: klornHeld ? null : safeMeetingLink(input.webUrl),
      storageKey: input.storageKey,
      // Decision V4: an external connector lists, searches and summarises; it never edits.
      readOnly: klornHeld ? input.readOnly === true : true,
      trashed: input.trashed === true,
    },
  };
}

/**
 * Create the row of this file, or bring it up to date. The identity is never
 * updated, a storage key the caller did not name is left alone, and the summary
 * state (D4's) is never touched.
 */
export async function upsertDriveFileRow(
  userId: string,
  source: DriveFileSource,
  input: DriveFileInput,
): Promise<DriveRowWriteResult> {
  const row = driveRowData(userId, source, input);
  if (!row.ok) return row;
  const { userId: owner, provider, sourceKey, externalId, ...metadata } = row.data;
  const written = await prisma.driveFile.upsert({
    where: { driveFileIdentity: { userId: owner, provider, sourceKey, externalId } },
    create: row.data,
    update: metadata,
    select: { id: true },
  });
  return { ok: true, id: written.id };
}
