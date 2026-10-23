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
import type { UserStorage } from "../storage/user-storage.js";
import { toDriveFileWire } from "./drive-read.js";
import {
  deleteKlornDriveRows,
  KLORN_DRIVE_SOURCE_KEY,
  klornDriveSource,
  upsertDriveFileRow,
} from "./drive-rows.js";
import { type DriveProviderEnabledMap, driveProvidersFor } from "./drive-scope.js";
import { klornStoredTypePolicy, SNIFF_BYTES, sniffContentType } from "./klorn-content-type.js";
import { KlornDriveError } from "./klorn-errors.js";
import { cleanKlornFileName } from "./klorn-file-name.js";
import { assertWithinKlornQuota } from "./klorn-quota.js";
import { resolveKlornParent } from "./klorn-tree.js";
import { enqueueSummaryOnWrite } from "./summary-triggers.js";

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
  if (typeof raw !== "string" || !DECIMAL_BYTES.test(raw)) {
    throw new KlornDriveError("invalid-upload");
  }
  const size = Number(raw);
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

/**
 * How long the first SNIFF_BYTES of a body may take to arrive. The PUT that
 * follows has its own bound (the S3 store's 120 s transfer timeout); without
 * this one a client could hold an upload open before the PUT starts.
 */
export const UPLOAD_HEAD_TIMEOUT_MS = 30_000;

/** Read chunks until SNIFF_BYTES are in hand or the body ends. */
async function collectHead(reader: AsyncIterator<Uint8Array>): Promise<Head> {
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

/** The head within UPLOAD_HEAD_TIMEOUT_MS; past it, the upload is refused (the caller releases the body). */
async function readHead(reader: AsyncIterator<Uint8Array>): Promise<Head> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new KlornDriveError("invalid-upload")), UPLOAD_HEAD_TIMEOUT_MS);
  });
  try {
    return await Promise.race([collectHead(reader), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The head again, then the rest. Releases the source as soon as the consumer
 * stops early; storeKlornUpload releases it in every other case.
 */
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

interface CheckedUpload {
  readonly name: string;
  readonly size: number;
  readonly parentExternalId: string | null;
}

/** Everything that can refuse an upload before a byte of it is read. */
async function checkKlornUpload(
  input: KlornUploadInput,
  providerEnabled: DriveProviderEnabledMap,
): Promise<CheckedUpload> {
  const name = cleanKlornFileName(input.fileName);
  if (name === null) throw new KlornDriveError("invalid-name");
  const size = parseDeclaredSize(input.declaredSize);
  const parentExternalId = await resolveKlornParent(
    input.userId,
    input.parentExternalId,
    providerEnabled,
  );
  await assertNotPurging(input.userId);
  await assertWithinKlornQuota(input.userId, size);
  return { name, size, parentExternalId };
}

/** Sniff the head, then stream the whole body to storage. Answers the key and the etag. */
async function putBody(
  storage: UserStorage,
  userId: string,
  checked: CheckedUpload,
  reader: AsyncIterator<Uint8Array>,
): Promise<{ key: string; mimeType: string; etag: string }> {
  const head = await readHead(reader);
  const truncated = !head.ended || head.bytes.byteLength > SNIFF_BYTES;
  // The bytes decide the type. The client's Content-Type is never read.
  const mimeType = sniffContentType(head.bytes, checked.name, { truncated });
  await assertNotPurging(userId);
  const hash = createHash("sha256");
  try {
    const stored = await storage.put(userId, "drive", hashing(replay(head, reader), hash), {
      contentType: mimeType,
      size: checked.size,
      contentTypePolicy: klornStoredTypePolicy,
      maxBytes: KLORN_DRIVE_MAX_FILE_BYTES,
    });
    return { key: stored.key, mimeType, etag: `sha256:${hash.digest("hex")}` };
  } catch (err) {
    throw uploadFailure(err);
  }
}

/** Phase one: every check, the sniff, and the object. No row is written. */
export async function storeKlornUpload(
  input: KlornUploadInput,
  providerEnabled: DriveProviderEnabledMap = driveProvidersFor(input.userId),
): Promise<StoredKlornUpload> {
  const { userId } = input;
  const checked = await checkKlornUpload(input, providerEnabled);
  const storage = await getUserStorage();
  if (!storage) throw new KlornDriveError("storage-unavailable");

  const reader = input.body[Symbol.asyncIterator]();
  let body: { key: string; mimeType: string; etag: string };
  try {
    body = await putBody(storage, userId, checked, reader);
  } finally {
    // Releases the source whatever happened, also when the PUT never started.
    await reader.return?.();
  }
  const upload: StoredKlornUpload = { userId, ...checked, ...body };
  let purging: boolean;
  try {
    purging = await isStoragePurgePending(userId);
  } catch (err) {
    await discardKlornUpload(upload);
    throw err;
  }
  if (purging) {
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

/** The row of a stored upload; the object is deleted if the row cannot be written. */
async function writeUploadRow(
  upload: StoredKlornUpload,
  externalId: string,
  now: Date,
): Promise<string> {
  let written: Awaited<ReturnType<typeof upsertDriveFileRow>>;
  try {
    written = await upsertDriveFileRow(upload.userId, klornDriveSource(externalId), {
      name: upload.name,
      modifiedAt: now,
      mimeType: upload.mimeType,
      isFolder: false,
      sizeBytes: upload.size,
      parentExternalId: upload.parentExternalId,
      storageKey: upload.key,
      etag: upload.etag,
    });
  } catch (err) {
    await discardKlornUpload(upload);
    throw err;
  }
  if (!written.ok) {
    await discardKlornUpload(upload);
    throw new KlornDriveError("invalid-upload");
  }
  return written.id;
}

/**
 * Phase two: the row, written only now that the object exists. The quota is
 * checked again right before it, which narrows the window two concurrent
 * uploads have to both pass from the length of a PUT to the length of a query.
 * If a deletion of the user's data started meanwhile, the row is removed again
 * (row first: the pending purge deletes the object even if this delete fails).
 */
export async function commitKlornUpload(
  upload: StoredKlornUpload,
  now: Date = new Date(),
): Promise<DriveFileWire> {
  try {
    await assertWithinKlornQuota(upload.userId, upload.size);
  } catch (err) {
    await discardKlornUpload(upload);
    throw err;
  }
  const externalId = randomUUID();
  const id = await writeUploadRow(upload, externalId, now);
  if (await isStoragePurgePending(upload.userId)) {
    await deleteKlornDriveRows(upload.userId, [externalId]);
    await discardKlornUpload(upload);
    throw new KlornDriveError("account-purging");
  }
  // D4: queue its summary (a no-op while summaries are off). Never throws.
  await enqueueSummaryOnWrite(upload.userId, id, upload.etag);
  return toDriveFileWire({
    id,
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
