/**
 * An in-memory ObjectStore (step D1 of docs/providers/unified-platform-plan.md)
 * for tests: D3, D4 and E4 build on it. It runs the same checks as the real
 * store through the shared helpers in `object-store.ts`, and the contract suite
 * holds both to the same behaviour. Never constructed outside tests.
 */

import { Readable } from "node:stream";
import { assertValidObjectKey } from "./keys.js";
import {
  assertBeforeDeadline,
  assertDeletablePrefix,
  type DeleteByPrefixOptions,
  type DeleteByPrefixResult,
  type ObjectBody,
  type ObjectMeta,
  type ObjectStore,
  type ObjectStoreLimits,
  type PutObjectOptions,
  prepareSignedDownload,
  prepareUpload,
  resolveStoreLimits,
  type SignedDownload,
  type SignedDownloadOptions,
  type StoredObject,
} from "./object-store.js";

/** `.invalid` never resolves (RFC 2606): a fake URL cannot reach a real host. */
const FAKE_ORIGIN = "https://objects.memory.invalid";
const FAKE_BUCKET = "memory";

interface Entry {
  bytes: Uint8Array;
  contentType: string;
}

export class MemoryObjectStore implements ObjectStore {
  readonly maxObjectBytes: number;
  private readonly deletePageSize: number;
  private readonly objects = new Map<string, Entry>();

  constructor(limits: ObjectStoreLimits = {}) {
    const resolved = resolveStoreLimits(limits);
    this.maxObjectBytes = resolved.maxObjectBytes;
    this.deletePageSize = resolved.deletePageSize;
  }

  /** Every key held, sorted. For assertions in tests. */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  async putObject(key: string, body: ObjectBody, options: PutObjectOptions): Promise<ObjectMeta> {
    const upload = prepareUpload(key, body, options, this.maxObjectBytes);
    const parts: Uint8Array[] = [];
    // The entry is written only after the whole guarded stream has passed.
    for await (const chunk of upload.body) parts.push(Uint8Array.from(chunk));
    this.objects.set(key, { bytes: Buffer.concat(parts), contentType: upload.contentType });
    return { key, size: upload.size, contentType: upload.contentType };
  }

  async getObject(key: string): Promise<StoredObject | null> {
    const meta = await this.headObject(key);
    const entry = this.objects.get(key);
    if (!meta || !entry) return null;
    return { ...meta, body: Readable.from([Uint8Array.from(entry.bytes)], { objectMode: true }) };
  }

  headObject(key: string): Promise<ObjectMeta | null> {
    return this.run(() => {
      assertValidObjectKey(key);
      const entry = this.objects.get(key);
      return entry ? { key, size: entry.bytes.byteLength, contentType: entry.contentType } : null;
    });
  }

  deleteObject(key: string): Promise<void> {
    return this.run(() => {
      assertValidObjectKey(key);
      this.objects.delete(key);
    });
  }

  deleteByPrefix(
    prefix: string,
    options: DeleteByPrefixOptions = {},
  ): Promise<DeleteByPrefixResult> {
    return this.run(() => {
      assertDeletablePrefix(prefix);
      assertBeforeDeadline(options.signal);
      const matching = this.keys().filter((key) => key.startsWith(prefix));
      const page = matching.slice(0, this.deletePageSize);
      for (const key of page) this.objects.delete(key);
      return { deleted: page.length, more: matching.length > page.length };
    });
  }

  signedDownloadUrl(key: string, options: SignedDownloadOptions): Promise<SignedDownload> {
    return this.run(() => {
      const download = prepareSignedDownload(key, options);
      const url = new URL(`${FAKE_ORIGIN}/${FAKE_BUCKET}/${download.key}`);
      url.searchParams.set("X-Amz-Expires", String(download.expiresInSeconds));
      url.searchParams.set("response-content-disposition", download.contentDisposition);
      url.searchParams.set("response-content-type", download.contentType);
      return { url: url.toString(), expiresInSeconds: download.expiresInSeconds };
    });
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  /** Turn a synchronous check into the rejected promise the interface promises. */
  private run<T>(work: () => T): Promise<T> {
    try {
      return Promise.resolve(work());
    } catch (err) {
      return Promise.reject(err);
    }
  }
}
