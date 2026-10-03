/**
 * The storage seam (step D1 of docs/providers/unified-platform-plan.md). The
 * Klorn drive (D3), file summaries (D4) and mailbox attachments (E4) depend on
 * this interface, never on a vendor SDK. Decision P6 keeps the vendor open:
 * anything that speaks the S3 API fits behind it.
 *
 * The rules every implementation keeps, checked by the contract suite
 * (`__tests__/helpers/object-store-contract.ts`):
 *
 *   - a key must match the grammar in `keys.ts`, or the call is refused;
 *   - an upload is capped before it starts and counted while it runs;
 *   - a signed URL lives at most MAX_SIGNED_URL_EXPIRY_SECONDS and always
 *     downloads as an attachment of type application/octet-stream;
 *   - a bulk delete runs only on one user's prefix, one bounded page per call.
 *
 * The helpers below are how an implementation keeps them. Ownership (which user
 * may touch which key) is one level up, in `user-storage.ts`.
 */

import { Readable } from "node:stream";
import { attachmentDisposition } from "./download-name.js";
import { StorageError } from "./errors.js";
import { assertValidObjectKey, isDeletablePrefix } from "./keys.js";
import {
  assertSignedUrlExpiry,
  assertUploadSize,
  guardBytes,
  MAX_OBJECT_BYTES,
  normalizeContentType,
  SIGNED_DOWNLOAD_CONTENT_TYPE,
} from "./limits.js";

/** Bytes in memory, or any stream of chunks (a Node Readable is one). */
export type ObjectBody = Uint8Array | AsyncIterable<Uint8Array>;

export interface PutObjectOptions {
  contentType: string;
  /** Exact byte length. Sent as Content-Length and checked against the stream. */
  size: number;
}

export interface ObjectMeta {
  key: string;
  size: number;
  contentType: string;
}

export interface StoredObject extends ObjectMeta {
  body: Readable;
}

export interface SignedDownloadOptions {
  /** 1 to MAX_SIGNED_URL_EXPIRY_SECONDS. A longer value is refused, not shortened. */
  expiresInSeconds: number;
  /** The display file name. Cleaned before use; never part of the key. */
  downloadName: string;
}

export interface SignedDownload {
  url: string;
  expiresInSeconds: number;
}

export interface DeleteByPrefixResult {
  /** Objects removed by this call. */
  deleted: number;
  /** True when the prefix still held objects after this page. Call again. */
  more: boolean;
}

export interface ObjectStore {
  /**
   * Store one object. Nothing is stored unless the whole body arrives and
   * matches `size`. When the call fails, the body may be left unread or partly
   * read: the caller disposes of its own stream.
   */
  putObject(key: string, body: ObjectBody, options: PutObjectOptions): Promise<ObjectMeta>;
  /** The object as a stream, or null when the key holds nothing. */
  getObject(key: string): Promise<StoredObject | null>;
  headObject(key: string): Promise<ObjectMeta | null>;
  /** Idempotent: deleting a key that holds nothing succeeds. */
  deleteObject(key: string): Promise<void>;
  /** Delete at most one page of objects under a user prefix. */
  deleteByPrefix(prefix: string): Promise<DeleteByPrefixResult>;
  signedDownloadUrl(key: string, options: SignedDownloadOptions): Promise<SignedDownload>;
  /** Cheap reachability and permission check. Rejects with a StorageError. */
  ping(): Promise<void>;
}

/** The most keys one `deleteByPrefix` call lists and removes (the S3 page size). */
export const DELETE_PAGE_SIZE = 1000;

/** Limits a store may be built with. They only ever tighten the defaults. */
export interface ObjectStoreLimits {
  maxObjectBytes?: number;
  deletePageSize?: number;
}

function resolveLimit(name: string, requested: number | undefined, ceiling: number): number {
  if (requested === undefined) return ceiling;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > ceiling) {
    throw new StorageError("misconfigured", `${name} must be a whole number from 1 to ${ceiling}`);
  }
  return requested;
}

export function resolveStoreLimits(limits: ObjectStoreLimits = {}): Required<ObjectStoreLimits> {
  return {
    maxObjectBytes: resolveLimit("maxObjectBytes", limits.maxObjectBytes, MAX_OBJECT_BYTES),
    deletePageSize: resolveLimit("deletePageSize", limits.deletePageSize, DELETE_PAGE_SIZE),
  };
}

export interface PreparedUpload {
  key: string;
  contentType: string;
  size: number;
  /** The body behind the byte counter. Reading it past the cap throws. */
  body: AsyncIterable<Uint8Array>;
}

/** Any body as a stream of chunks. Bytes in memory become a one-chunk stream. */
export function bodyChunks(body: ObjectBody): AsyncIterable<Uint8Array> {
  return body instanceof Uint8Array ? Readable.from([body], { objectMode: true }) : body;
}

/** Everything an upload is checked for before a single byte is read. */
export function prepareUpload(
  key: string,
  body: ObjectBody,
  options: PutObjectOptions,
  maxObjectBytes: number,
): PreparedUpload {
  assertValidObjectKey(key);
  const contentType = normalizeContentType(options.contentType);
  assertUploadSize(options.size, maxObjectBytes);
  return {
    key,
    contentType,
    size: options.size,
    body: guardBytes(bodyChunks(body), { declaredSize: options.size, maxBytes: maxObjectBytes }),
  };
}

export interface PreparedSignedDownload {
  key: string;
  expiresInSeconds: number;
  /** Always `attachment;…`. */
  contentDisposition: string;
  /** Always application/octet-stream. */
  contentType: string;
}

/** Everything a signed URL is checked for, and the two pinned response headers. */
export function prepareSignedDownload(
  key: string,
  options: SignedDownloadOptions,
): PreparedSignedDownload {
  assertValidObjectKey(key);
  assertSignedUrlExpiry(options.expiresInSeconds);
  return {
    key,
    expiresInSeconds: options.expiresInSeconds,
    contentDisposition: attachmentDisposition(options.downloadName),
    contentType: SIGNED_DOWNLOAD_CONTENT_TYPE,
  };
}

/** Throws `invalid-prefix` unless the prefix is one user's tree or one purpose in it. */
export function assertDeletablePrefix(prefix: string): void {
  if (!isDeletablePrefix(prefix)) {
    throw new StorageError("invalid-prefix", "bulk delete needs a user prefix ending in a slash");
  }
}
