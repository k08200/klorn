/**
 * The S3-compatible ObjectStore (step D1 of
 * docs/providers/unified-platform-plan.md). One implementation for Cloudflare
 * R2 (decision L15), MinIO and Supabase Storage (P6): plain S3 REST calls over
 * `fetch`, signed with SigV4 by aws4fetch. No vendor SDK.
 *
 * What a request is built from:
 *   - host, bucket and credentials: the operator's config, fixed at construction;
 *   - the path: a key that matched the grammar in `keys.ts`;
 *   - nothing else. A download name only ever becomes a signed query VALUE.
 *
 * Uploads are streamed with a Content-Length and an unsigned payload (TLS
 * carries the integrity), so a 25 MiB file is never held in memory. Nothing is
 * retried: a streamed body cannot be replayed, and the other calls are
 * idempotent, so the caller retries.
 */

import { Readable } from "node:stream";
import { ReadableStream } from "node:stream/web";
import { AwsV4Signer } from "aws4fetch";
import { StorageError, type StorageErrorCode } from "./errors.js";
import { assertValidObjectKey, parseObjectKey } from "./keys.js";
import { mediaTypeOf } from "./limits.js";
import {
  assertDeletablePrefix,
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
import { assertS3StoreConfig, type S3StoreConfig } from "./s3-config.js";
import { type ListPage, parseListObjectsXml, s3ErrorCodeOf } from "./s3-xml.js";

export type { S3StoreConfig } from "./s3-config.js";

const SERVICE = "s3";
/** How long a metadata call (head, delete, list) may take. */
const REQUEST_TIMEOUT_MS = 15_000;
/** How long one upload or one download may take, body included. */
const TRANSFER_TIMEOUT_MS = 120_000;
/** Deletes in flight at once inside one `deleteByPrefix` page. */
const DELETE_CONCURRENCY = 8;
/** The prefix every key lives under; what `ping` lists one key of. */
const ROOT_PREFIX = "u/";
const FALLBACK_CONTENT_TYPE = "application/octet-stream";

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
}

/** `YYYYMMDD'T'HHMMSS'Z'`, the SigV4 timestamp. */
function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/** What went wrong on the socket, in words that carry no URL and no header. */
function describeNetworkError(err: unknown): string {
  const name = err instanceof Error ? err.name : "Error";
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === "string" ? `${name} ${cause.code}` : name;
}

function contentTypeOf(headers: Headers): string {
  return mediaTypeOf(headers.get("content-type")) ?? FALLBACK_CONTENT_TYPE;
}

function metaOf(key: string, headers: Headers): ObjectMeta {
  const size = Number(headers.get("content-length"));
  if (headers.get("content-length") === null || !Number.isSafeInteger(size) || size < 0) {
    throw new StorageError("upstream", "object storage answered without a usable Content-Length");
  }
  return { key, size, contentType: contentTypeOf(headers) };
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
    const upload = prepareUpload(key, body, options, this.maxObjectBytes);
    const guarded = rememberFailure(upload.body);
    let response: Response;
    try {
      response = await this.send("PUT", this.objectUrl(key), {
        headers: { "content-type": upload.contentType, "content-length": String(upload.size) },
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
    const response = await this.send("DELETE", this.objectUrl(key), {
      timeoutMs: this.requestTimeoutMs,
    });
    if (response.status === 404) {
      await this.missing(response, "delete");
      return;
    }
    if (!response.ok) throw await this.failure(response, "delete");
    await response.body?.cancel();
  }

  async deleteByPrefix(prefix: string): Promise<DeleteByPrefixResult> {
    assertDeletablePrefix(prefix);
    const page = await this.listPage(prefix, this.deletePageSize);
    // Delete only what is provably under the prefix. A listing that names
    // anything else is a vendor fault, and the whole page is left alone.
    const foreign = page.keys.some((key) => !key.startsWith(prefix) || !parseObjectKey(key));
    if (foreign) {
      throw new StorageError(
        "upstream",
        "object storage listed a key outside the requested prefix; nothing was deleted",
      );
    }
    const failures = await this.deleteKeys(page.keys);
    if (failures.length > 0) {
      throw new StorageError(
        "delete-incomplete",
        `${failures.length} of ${page.keys.length} objects under the prefix could not be deleted`,
        { cause: failures[0] },
      );
    }
    return { deleted: page.keys.length, more: page.truncated };
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

  private bucketUrl(): URL {
    const url = new URL(this.#config.endpoint);
    const basePath = url.pathname.replace(/\/+$/, "");
    if (this.#config.forcePathStyle) {
      url.pathname = `${basePath}/${this.#config.bucket}`;
    } else {
      url.hostname = `${this.#config.bucket}.${url.hostname}`;
      url.pathname = basePath || "/";
    }
    return url;
  }

  /** The key has matched the grammar, so it needs no escaping and cannot climb. */
  private objectUrl(key: string): URL {
    const url = this.bucketUrl();
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${key}`;
    return url;
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
    try {
      return await this.fetchImpl(signed.url, {
        method,
        headers: signed.headers,
        body: init.body,
        // A streamed request body needs half duplex in Node's fetch.
        ...(init.body ? { duplex: "half" as const } : {}),
        // A redirect would carry the signed headers to another host.
        redirect: "manual",
        signal: AbortSignal.timeout(init.timeoutMs),
      });
    } catch (err) {
      throw new StorageError(
        "unreachable",
        `object storage did not answer (${describeNetworkError(err)})`,
        { cause: err },
      );
    }
  }

  /** A 404 on an object: null, unless it is the bucket that is missing. */
  private async missing(response: Response, action: string): Promise<null> {
    const upstreamCode = s3ErrorCodeOf(await response.text().catch(() => ""));
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
    const upstreamCode = s3ErrorCodeOf(await response.text().catch(() => ""));
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

  private async listPage(prefix: string, maxKeys: number): Promise<ListPage> {
    const url = this.bucketUrl();
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("max-keys", String(maxKeys));
    const response = await this.send("GET", url, { timeoutMs: this.requestTimeoutMs });
    if (!response.ok) throw await this.failure(response, "list", "bucket-not-found");
    return parseListObjectsXml(await response.text());
  }

  /** Delete the keys a few at a time. Returns the errors, one per key that stayed. */
  private async deleteKeys(keys: readonly string[]): Promise<unknown[]> {
    let failures: unknown[] = [];
    for (let start = 0; start < keys.length; start += DELETE_CONCURRENCY) {
      const batch = keys.slice(start, start + DELETE_CONCURRENCY);
      const results = await Promise.allSettled(batch.map((key) => this.deleteObject(key)));
      const rejected = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      failures = [...failures, ...rejected];
    }
    return failures;
  }
}
