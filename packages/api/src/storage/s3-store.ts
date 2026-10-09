/**
 * The S3-compatible ObjectStore (step D1 of
 * docs/providers/unified-platform-plan.md). One implementation for Cloudflare
 * R2 (decision L15), MinIO and Supabase Storage (P6): plain S3 REST calls over
 * `fetch`, signed with SigV4 by aws4fetch. No vendor SDK.
 *
 * What a request is built from:
 *   - host, bucket and credentials: the operator's config, fixed at construction;
 *   - the path: a key, percent-encoded and checked by `s3-address.ts`;
 *   - nothing else. A download name only ever becomes a signed query VALUE.
 *
 * Uploads are streamed with a Content-Length and an unsigned payload (TLS
 * carries the integrity), so a 25 MiB file is never held in memory. Every
 * object is stored as `application/octet-stream` with `Content-Disposition:
 * attachment`; the caller's content type is kept as metadata. A download is
 * therefore safe even from a vendor that ignores the signed response overrides.
 *
 * Nothing is retried: a streamed body cannot be replayed, and the other calls
 * are idempotent, so the caller retries (`StorageError.retryable` says when
 * that is worth it).
 *
 * This module is loaded lazily by `runtime.ts`, and only while the flag is on.
 */

import { Readable } from "node:stream";
import { ReadableStream } from "node:stream/web";
import { AwsV4Signer } from "aws4fetch";
import { StorageError, type StorageErrorCode } from "./errors.js";
import { assertValidObjectKey, parseObjectKey } from "./keys.js";
import { mediaTypeOf, SIGNED_DOWNLOAD_CONTENT_TYPE } from "./limits.js";
import {
  assertBeforeDeadline,
  assertDeletablePrefix,
  type DeleteByPrefixOptions,
  type DeleteByPrefixResult,
  type ObjectBody,
  type ObjectMeta,
  type ObjectStore,
  type ObjectStoreLimits,
  type PreparedUpload,
  type PutObjectOptions,
  prepareSignedDownload,
  prepareUpload,
  resolveStoreLimits,
  type SignedDownload,
  type SignedDownloadOptions,
  type StoredObject,
} from "./object-store.js";
import { bucketUrlOf, isAddressableKey, objectUrlOf } from "./s3-address.js";
import { assertS3StoreConfig, type S3StoreConfig } from "./s3-config.js";
import { describeNetworkError, readTextCapped } from "./s3-response.js";
import { type ListPage, parseListObjectsXml, s3ErrorCodeOf } from "./s3-xml.js";

export type { S3StoreConfig } from "./s3-config.js";

const SERVICE = "s3";
const LOG_PREFIX = "[STORAGE]";
/** How long a metadata call (head, delete, list) may take. */
const REQUEST_TIMEOUT_MS = 15_000;
/** How long one upload or one download may take, body included. */
const TRANSFER_TIMEOUT_MS = 120_000;
/** Deletes in flight at once inside one `deleteByPrefix` page. */
export const S3_DELETE_CONCURRENCY = 8;
/** The most a list answer may hold. A page of 1,000 keys is well under 1 MiB. */
export const S3_MAX_LIST_BODY_BYTES = 4 * 1024 * 1024;
/** The most that is read of an error body. Only its `<Code>` is used. */
export const S3_MAX_ERROR_BODY_BYTES = 16 * 1024;
/** The prefix every key lives under; what `ping` lists one key of. */
const ROOT_PREFIX = "u/";
/** What every object is stored as, whatever type the caller named. */
const STORED_CONTENT_TYPE = SIGNED_DOWNLOAD_CONTENT_TYPE;
const STORED_CONTENT_DISPOSITION = "attachment";
/** Where the caller's content type is kept: S3 user metadata, signed with the PUT. */
const CONTENT_TYPE_METADATA = "x-amz-meta-content-type";

export interface S3StoreOptions extends ObjectStoreLimits {
  /** Replaces the global `fetch`. For tests. */
  fetch?: typeof fetch;
  /** Replaces the clock used for the signing date. For tests. */
  now?: () => Date;
  requestTimeoutMs?: number;
  transferTimeoutMs?: number;
}

interface SendInit {
  headers?: Record<string, string>;
  body?: ReadableStream<Uint8Array>;
  timeoutMs: number;
  /** The caller's deadline, on top of the per-request timeout. */
  signal?: AbortSignal;
}

/** `YYYYMMDD'T'HHMMSS'Z'`, the SigV4 timestamp. */
function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function metaOf(key: string, headers: Headers): ObjectMeta {
  const size = Number(headers.get("content-length"));
  if (headers.get("content-length") === null || !Number.isSafeInteger(size) || size < 0) {
    throw new StorageError("upstream", "object storage answered without a usable Content-Length");
  }
  // The stored Content-Type is always octet-stream; the caller's is metadata.
  const contentType = mediaTypeOf(headers.get(CONTENT_TYPE_METADATA)) ?? STORED_CONTENT_TYPE;
  return { key, size, contentType };
}

/** Wrap a stream so the error that ended it can be read back after `fetch` fails. */
function rememberFailure(source: AsyncIterable<Uint8Array>): {
  stream: AsyncIterable<Uint8Array>;
  failure: () => unknown;
} {
  let failure: unknown;
  async function* relay(): AsyncGenerator<Uint8Array> {
    try {
      yield* source;
    } catch (err) {
      failure = err;
      throw err;
    }
  }
  return { stream: relay(), failure: () => failure };
}

function isRetryable(err: unknown): boolean {
  return err instanceof StorageError && err.retryable;
}

export class S3ObjectStore implements ObjectStore {
  // `#` fields, not `private`: the config holds the secret key, and a store that
  // is logged, inspected or serialised by accident must not print it.
  readonly #config: Readonly<S3StoreConfig>;
  private readonly maxObjectBytes: number;
  private readonly deletePageSize: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly requestTimeoutMs: number;
  private readonly transferTimeoutMs: number;
  /** aws4fetch's derived signing keys, one per day. Its map keys embed the secret. */
  readonly #signingKeys = new Map<string, ArrayBuffer>();

  constructor(config: S3StoreConfig, options: S3StoreOptions = {}) {
    assertS3StoreConfig(config);
    const limits = resolveStoreLimits(options);
    this.#config = Object.freeze({ ...config });
    this.maxObjectBytes = limits.maxObjectBytes;
    this.deletePageSize = limits.deletePageSize;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.transferTimeoutMs = options.transferTimeoutMs ?? TRANSFER_TIMEOUT_MS;
  }

  async putObject(key: string, body: ObjectBody, options: PutObjectOptions): Promise<ObjectMeta> {
    // A refusal here happens before anything is sent: there is nothing to undo.
    const upload = prepareUpload(key, body, options, this.maxObjectBytes);
    try {
      await this.upload(upload);
    } catch (err) {
      await this.discardFailedUpload(key);
      throw err;
    }
    return { key, size: upload.size, contentType: upload.contentType };
  }

  async getObject(key: string): Promise<StoredObject | null> {
    assertValidObjectKey(key);
    const response = await this.send("GET", this.objectUrl(key), {
      timeoutMs: this.transferTimeoutMs,
    });
    if (response.status === 404) return this.missing(response, "get");
    if (!response.ok || !response.body) throw await this.failure(response, "get");
    const web = response.body as ReadableStream<Uint8Array>;
    let meta: ObjectMeta;
    try {
      meta = metaOf(key, response.headers);
    } catch (err) {
      // Nobody will read this body: release the connection before refusing.
      await web.cancel();
      throw err;
    }
    return { ...meta, body: Readable.fromWeb(web) };
  }

  async headObject(key: string): Promise<ObjectMeta | null> {
    assertValidObjectKey(key);
    const response = await this.send("HEAD", this.objectUrl(key), {
      timeoutMs: this.requestTimeoutMs,
    });
    // A HEAD answer has no body, so a missing bucket cannot be told apart here.
    // `ping` and every GET do tell it apart.
    if (response.status === 404) return null;
    if (!response.ok) throw await this.failure(response, "head");
    return metaOf(key, response.headers);
  }

  async deleteObject(key: string): Promise<void> {
    assertValidObjectKey(key);
    await this.deleteAt(key);
  }

  async deleteByPrefix(
    prefix: string,
    options: DeleteByPrefixOptions = {},
  ): Promise<DeleteByPrefixResult> {
    assertDeletablePrefix(prefix);
    const { signal } = options;
    assertBeforeDeadline(signal);
    const page = await this.listPage(prefix, this.deletePageSize, signal);
    // A listing that names a key outside the prefix is a vendor fault. Nothing
    // on that page is trusted, and nothing is deleted.
    if (page.keys.some((key) => !key.startsWith(prefix))) {
      throw new StorageError(
        "upstream",
        "object storage listed a key outside the requested prefix; nothing was deleted",
      );
    }
    // Everything under the user's prefix goes, including a key this code did
    // not mint: a stray key must not block that user's deletion for good.
    const strays = page.keys.filter((key) => !parseObjectKey(key)).length;
    if (strays > 0) {
      console.warn(
        `${LOG_PREFIX} bulk delete: ${strays} key(s) under a user prefix do not match the key grammar; deleting them with the rest`,
      );
    }
    const addressable = page.keys.filter((key) => isAddressableKey(this.#config, key));
    await this.deleteKeys(addressable, signal);
    const left = page.keys.length - addressable.length;
    if (left > 0) {
      throw new StorageError(
        "delete-incomplete",
        `${left} key(s) under the prefix cannot be addressed over HTTP and were left; remove them at the storage vendor`,
      );
    }
    return { deleted: addressable.length, more: page.truncated };
  }

  async signedDownloadUrl(key: string, options: SignedDownloadOptions): Promise<SignedDownload> {
    const download = prepareSignedDownload(key, options);
    const url = this.objectUrl(download.key);
    url.searchParams.set("X-Amz-Expires", String(download.expiresInSeconds));
    url.searchParams.set("response-content-disposition", download.contentDisposition);
    url.searchParams.set("response-content-type", download.contentType);
    const signed = await this.signer("GET", url, { signQuery: true }).sign();
    return { url: signed.url.toString(), expiresInSeconds: download.expiresInSeconds };
  }

  /** Lists one key. Needs the same permission a purge needs, and nothing more. */
  async ping(): Promise<void> {
    await this.listPage(ROOT_PREFIX, 1);
  }

  private objectUrl(key: string): URL {
    return objectUrlOf(this.#config, key);
  }

  private async upload(upload: PreparedUpload): Promise<void> {
    const guarded = rememberFailure(upload.body);
    let response: Response;
    try {
      response = await this.send("PUT", this.objectUrl(upload.key), {
        headers: {
          "content-type": STORED_CONTENT_TYPE,
          "content-disposition": STORED_CONTENT_DISPOSITION,
          [CONTENT_TYPE_METADATA]: upload.contentType,
          "content-length": String(upload.size),
        },
        body: ReadableStream.from(guarded.stream),
        timeoutMs: this.transferTimeoutMs,
      });
    } catch (err) {
      // The byte counter (or the caller's own stream) ended the upload: say so,
      // rather than reporting the dropped connection it caused.
      throw guarded.failure() ?? err;
    }
    if (!response.ok) throw await this.failure(response, "put");
    await response.body?.cancel();
  }

  /**
   * After a failed upload, remove whatever is at the key. A bucket can commit
   * an upload and still fail to say so (a lost answer, a 5xx after the write),
   * and the caller has been told the upload failed, so nothing would ever point
   * at that object. Best effort: the upload's own error is what the caller
   * gets. Safe because `putObject` is for fresh keys.
   */
  private async discardFailedUpload(key: string): Promise<void> {
    try {
      await this.deleteAt(key);
    } catch (err) {
      const code = err instanceof StorageError ? err.code : "upstream";
      console.warn(
        `${LOG_PREFIX} a failed upload may have left an object behind: the clean-up delete failed too (${code})`,
      );
    }
  }

  /** DELETE one key that `objectUrlOf` can address. Idempotent. */
  private async deleteAt(key: string, signal?: AbortSignal): Promise<void> {
    const response = await this.send("DELETE", this.objectUrl(key), {
      timeoutMs: this.requestTimeoutMs,
      signal,
    });
    if (response.status === 404) {
      await this.missing(response, "delete");
      return;
    }
    if (!response.ok) throw await this.failure(response, "delete");
    await response.body?.cancel();
  }

  private signer(
    method: string,
    url: URL,
    extra: { headers?: Record<string, string>; signQuery?: boolean } = {},
  ): AwsV4Signer {
    return new AwsV4Signer({
      method,
      url: url.toString(),
      headers: extra.headers,
      signQuery: extra.signQuery,
      accessKeyId: this.#config.accessKeyId,
      secretAccessKey: this.#config.secretAccessKey,
      region: this.#config.region,
      service: SERVICE,
      cache: this.#signingKeys,
      datetime: amzDate(this.now()),
    });
  }

  private async send(method: string, url: URL, init: SendInit): Promise<Response> {
    const signed = await this.signer(method, url, { headers: init.headers }).sign();
    const timeout = AbortSignal.timeout(init.timeoutMs);
    try {
      return await this.fetchImpl(signed.url, {
        method,
        headers: signed.headers,
        body: init.body,
        // A streamed request body needs half duplex in Node's fetch.
        ...(init.body ? { duplex: "half" as const } : {}),
        // A redirect would carry the signed headers to another host.
        redirect: "manual",
        signal: init.signal ? AbortSignal.any([timeout, init.signal]) : timeout,
      });
    } catch (err) {
      throw new StorageError(
        "unreachable",
        `object storage did not answer (${describeNetworkError(err)})`,
        { cause: err },
      );
    }
  }

  /** The vendor's error code from an error body, read with a cap. */
  private async errorCodeOf(response: Response): Promise<string | undefined> {
    try {
      return s3ErrorCodeOf((await readTextCapped(response, S3_MAX_ERROR_BODY_BYTES)).text);
    } catch {
      // The error is built from the status either way. A body that cannot be
      // read only means the vendor's own code is missing from it.
      return undefined;
    }
  }

  /** A 404 on an object: null, unless it is the bucket that is missing. */
  private async missing(response: Response, action: string): Promise<null> {
    const upstreamCode = await this.errorCodeOf(response);
    if (upstreamCode === "NoSuchBucket") {
      throw this.error("bucket-not-found", action, response.status, upstreamCode);
    }
    return null;
  }

  private async failure(
    response: Response,
    action: string,
    notFound: StorageErrorCode = "upstream",
  ): Promise<StorageError> {
    // Only the vendor's error code is read from the body. The rest of an S3
    // error body can repeat the access key id and the string that was signed.
    const upstreamCode = await this.errorCodeOf(response);
    const { status } = response;
    if (status === 401 || status === 403) {
      return this.error("access-denied", action, status, upstreamCode);
    }
    if (upstreamCode === "NoSuchBucket") {
      return this.error("bucket-not-found", action, status, upstreamCode);
    }
    return this.error(status === 404 ? notFound : "upstream", action, status, upstreamCode);
  }

  private error(
    code: StorageErrorCode,
    action: string,
    status: number,
    upstreamCode: string | undefined,
  ): StorageError {
    const detail = upstreamCode ? `HTTP ${status} ${upstreamCode}` : `HTTP ${status}`;
    return new StorageError(code, `object storage ${action} failed: ${detail}`, {
      status,
      upstreamCode,
    });
  }

  private async listPage(prefix: string, maxKeys: number, signal?: AbortSignal): Promise<ListPage> {
    const url = bucketUrlOf(this.#config);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("max-keys", String(maxKeys));
    const response = await this.send("GET", url, { timeoutMs: this.requestTimeoutMs, signal });
    if (!response.ok) throw await this.failure(response, "list", "bucket-not-found");
    return parseListObjectsXml(await this.listBody(response));
  }

  /** The list answer as text: capped, and a stalled body is an error with a name. */
  private async listBody(response: Response): Promise<string> {
    let body: Awaited<ReturnType<typeof readTextCapped>>;
    try {
      body = await readTextCapped(response, S3_MAX_LIST_BODY_BYTES);
    } catch (err) {
      throw new StorageError(
        "unreachable",
        `object storage stopped answering during a list (${describeNetworkError(err)})`,
        { cause: err },
      );
    }
    if (body.truncated) {
      throw new StorageError(
        "upstream",
        `object storage list answer is over ${S3_MAX_LIST_BODY_BYTES} bytes`,
      );
    }
    return body.text;
  }

  /**
   * Delete the keys a few at a time, and stop at the first batch with a
   * failure. Against a bucket that is failing, going on would cost one timeout
   * per batch for the whole page.
   */
  private async deleteKeys(keys: readonly string[], signal?: AbortSignal): Promise<void> {
    for (let start = 0; start < keys.length; start += S3_DELETE_CONCURRENCY) {
      assertBeforeDeadline(signal);
      const batch = keys.slice(start, start + S3_DELETE_CONCURRENCY);
      const results = await Promise.allSettled(batch.map((key) => this.deleteAt(key, signal)));
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      if (failures.length > 0) {
        throw new StorageError(
          "delete-incomplete",
          `${failures.length} of ${batch.length} objects in one batch could not be deleted; stopped with ${keys.length - start} of ${keys.length} keys on the page not yet confirmed deleted`,
          { cause: failures[0], retryable: failures.every(isRetryable) },
        );
      }
    }
  }
}
