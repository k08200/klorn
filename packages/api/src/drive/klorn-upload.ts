/**
 * Upload into the Klorn drive (step D3 of docs/providers/unified-platform-plan.md).
 *
 * Two phases, so the route can write the row only once the whole request has
 * been read cleanly:
 *
 *   store   — check the name, the declared size, the parent folder, the purge
 *             record and the quota; sniff the type from the first bytes; stream
 *             the body to `getUserStorage().put` under a key D1 mints. The
 *             declared size is checked before the first byte and the stream is
 *             counted while it runs (D1's guard), so nothing over the cap or
 *             unlike its declared size is stored.
 *   commit  — write the DriveFile row, AFTER the object exists. If the row
 *             cannot be written the object is deleted.
 *
 * `discardKlornUpload` deletes a stored object whose row will not be written.
 *
 * The upload-during-purge race (D1 review). The purge record is checked three
 * times: before anything, right before the PUT, and after it. An upload that
 * passed the second check before a deletion started lands within one PUT
 * timeout; the record's late-upload grace (storage/purge-queue.ts) is longer
 * than that, so the sweep's finishing pass deletes it.
 */

import { createHash, type Hash, randomUUID } from "node:crypto";
import type { DriveFileWire } from "@klorn/contract";
import { captureError } from "../sentry.js";
import { StorageError } from "../storage/errors.js";
import { MAX_OBJECT_BYTES } from "../storage/limits.js";
import { isStoragePurgePending } from "../storage/purge-queue.js";
import { getUserStorage } from "../storage/runtime.js";
import { toDriveFileWire } from "./drive-read.js";
import { KLORN_DRIVE_SOURCE_KEY, klornDriveSource, upsertDriveFileRow } from "./drive-rows.js";
import { DRIVE_PROVIDER_ENABLED, type DriveProviderEnabledMap } from "./drive-scope.js";
import { klornStoredTypePolicy, SNIFF_BYTES, sniffContentType } from "./klorn-content-type.js";
import { KlornDriveError } from "./klorn-errors.js";
import { cleanKlornFileName } from "./klorn-file-name.js";
import { assertWithinKlornQuota } from "./klorn-quota.js";
import { resolveKlornParent } from "./klorn-tree.js";

/**
 * The largest file: D1's cap (25 MiB, L14), the only size the plan has decided.
 * Raising it is a change to MAX_OBJECT_BYTES itself; a drive-only number below
 * it would go here.
 */
export const KLORN_DRIVE_MAX_FILE_BYTES = MAX_OBJECT_BYTES;

/** A declared size: decimal digits only, no sign, no exponent, no padding. */
const DECIMAL_BYTES = /^(0|[1-9]\d{0,14})$/;

export interface KlornUploadInput {
  readonly userId: string;
  /** The multipart part's filename, as sent. */
  readonly fileName: unknown;
  /** The `size` field, as sent. */
  readonly declaredSize: unknown;
  /** The `parentExternalId` field, as sent; undefined when absent. */
  readonly parentExternalId: unknown;
  readonly body: AsyncIterable<Uint8Array>;
}

/** An object that is stored and has no row yet. */
export interface StoredKlornUpload {
  readonly userId: string;
  readonly key: string;
  readonly name: string;
  readonly size: number;
  readonly mimeType: string;
  readonly etag: string;
  readonly parentExternalId: string | null;
}

/** The declared size, or a refusal before a single byte is read. */
export function parseDeclaredSize(raw: unknown): number {
  if (typeof raw !== "string" || !DECIMAL_BYTES.test(raw.trim())) {
    throw new KlornDriveError("invalid-upload");
  }
  const size = Number(raw.trim());
  if (size > KLORN_DRIVE_MAX_FILE_BYTES) throw new KlornDriveError("too-large");
  return size;
}

async function assertNotPurging(userId: string): Promise<void> {
  if (await isStoragePurgePending(userId)) throw new KlornDriveError("account-purging");
}

interface Head {
  readonly chunks: Uint8Array[];
  readonly bytes: Uint8Array;
  readonly ended: boolean;
}

/** Read chunks until SNIFF_BYTES are in hand or the body ends. */
async function readHead(reader: AsyncIterator<Uint8Array>): Promise<Head> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < SNIFF_BYTES) {
    const next = await reader.next();
    if (next.done) return { chunks, bytes: Buffer.concat(chunks), ended: true };
    chunks.push(next.value);
    length += next.value.byteLength;
  }
  return { chunks, bytes: Buffer.concat(chunks), ended: false };
}

/** The head again, then the rest; releases the source if the reader stops early. */
async function* replay(head: Head, reader: AsyncIterator<Uint8Array>): AsyncGenerator<Uint8Array> {
  try {
    yield* head.chunks;
    if (head.ended) return;
    for (let next = await reader.next(); !next.done; next = await reader.next()) {
      yield next.value;
    }
  } finally {
    await reader.return?.();
  }
}

async function* hashing(source: AsyncIterable<Uint8Array>, hash: Hash): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) {
    hash.update(chunk);
    yield chunk;
  }
}

/** What a failed PUT means for the person. Anything not listed is a bug and stays a 500. */
function uploadFailure(err: unknown): unknown {
  if (!(err instanceof StorageError)) return err;
  switch (err.code) {
    case "object-too-large":
      return new KlornDriveError("too-large", { cause: err });
    case "size-mismatch":
    case "invalid-size":
      return new KlornDriveError("invalid-upload", { cause: err });
    case "unreachable":
    case "upstream":
    case "misconfigured":
    case "access-denied":
    case "bucket-not-found":
      return new KlornDriveError("storage-unavailable", { retryable: err.retryable, cause: err });
    default:
      return err;
  }
}

/** Phase one: every check, the sniff, and the object. No row is written. */
export async function storeKlornUpload(
  input: KlornUploadInput,
  providerEnabled: DriveProviderEnabledMap = DRIVE_PROVIDER_ENABLED,
): Promise<StoredKlornUpload> {
  const { userId } = input;
  const name = cleanKlornFileName(input.fileName);
  if (name === null) throw new KlornDriveError("invalid-name");
  const size = parseDeclaredSize(input.declaredSize);
  const parentExternalId = await resolveKlornParent(
    userId,
    input.parentExternalId,
    providerEnabled,
  );
  await assertNotPurging(userId);
  await assertWithinKlornQuota(userId, size);
  const storage = await getUserStorage();
  if (!storage) throw new KlornDriveError("storage-unavailable");

  const reader = input.body[Symbol.asyncIterator]();
  const head = await readHead(reader);
  const truncated = !head.ended || head.bytes.byteLength > SNIFF_BYTES;
  // The bytes decide the type. The client's Content-Type is never read.
  const mimeType = sniffContentType(head.bytes, name, { truncated });

  await assertNotPurging(userId);
  const hash = createHash("sha256");
  let key: string;
  try {
    const stored = await storage.put(userId, "drive", hashing(replay(head, reader), hash), {
      contentType: mimeType,
      size,
      contentTypePolicy: klornStoredTypePolicy,
      maxBytes: KLORN_DRIVE_MAX_FILE_BYTES,
    });
    key = stored.key;
  } catch (err) {
    throw uploadFailure(err);
  }
  const upload: StoredKlornUpload = {
    userId,
    key,
    name,
    size,
    mimeType,
    etag: `sha256:${hash.digest("hex")}`,
    parentExternalId,
  };
  if (await isStoragePurgePending(userId)) {
    await discardKlornUpload(upload);
    throw new KlornDriveError("account-purging");
  }
  return upload;
}

/**
 * Delete a stored object whose row will not be written. Best effort: a failure
 * is logged and reported (the object then waits for the account purge, which
 * deletes the whole prefix), and never replaces the error that got us here.
 */
export async function discardKlornUpload(upload: StoredKlornUpload): Promise<void> {
  try {
    const storage = await getUserStorage();
    await storage?.delete(upload.userId, upload.key);
  } catch (err) {
    console.error(
      `[DRIVE] could not delete an upload left without a row for user ${upload.userId}`,
    );
    captureError(err, {
      tags: { scope: "drive.upload.cleanup" },
      extra: { userId: upload.userId },
    });
  }
}

/** Phase two: the row, written only now that the object exists. */
export async function commitKlornUpload(
  upload: StoredKlornUpload,
  now: Date = new Date(),
): Promise<DriveFileWire> {
  const externalId = randomUUID();
  const row = {
    name: upload.name,
    modifiedAt: now,
    mimeType: upload.mimeType,
    isFolder: false,
    sizeBytes: upload.size,
    parentExternalId: upload.parentExternalId,
    storageKey: upload.key,
    etag: upload.etag,
  };
  let written: Awaited<ReturnType<typeof upsertDriveFileRow>>;
  try {
    written = await upsertDriveFileRow(upload.userId, klornDriveSource(externalId), row);
  } catch (err) {
    await discardKlornUpload(upload);
    throw err;
  }
  if (!written.ok) {
    await discardKlornUpload(upload);
    throw new KlornDriveError("invalid-upload");
  }
  return toDriveFileWire({
    id: written.id,
    provider: "KLORN",
    sourceKey: KLORN_DRIVE_SOURCE_KEY,
    externalId,
    name: upload.name,
    mimeType: upload.mimeType,
    isFolder: false,
    sizeBytes: BigInt(upload.size),
    parentExternalId: upload.parentExternalId,
    modifiedAt: now,
    webUrl: null,
  });
}
