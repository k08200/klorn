/**
 * User-scoped storage (step D1 of docs/providers/unified-platform-plan.md).
 * This is the layer the Klorn drive (D3), file summaries (D4) and mailbox
 * attachments (E4) call. Every function takes the user it acts for:
 *
 *   - an upload gets a key minted under that user's prefix;
 *   - any other call refuses a key outside that prefix, before the store is
 *     touched. A caller cannot reach another user's object by passing its key.
 *
 * The user id must come from the session, never from a request body. The
 * content-type policy is the caller's: this layer asks it and obeys.
 */

import { StorageError } from "./errors.js";
import { assertKeyBelongsToUser, newObjectKey, type StoragePurpose, userPrefix } from "./keys.js";
import {
  assertUploadSize,
  type ContentTypePolicy,
  guardBytes,
  normalizeContentType,
} from "./limits.js";
import type {
  ObjectBody,
  ObjectMeta,
  ObjectStore,
  SignedDownload,
  SignedDownloadOptions,
  StoredObject,
} from "./object-store.js";
import { bodyChunks } from "./object-store.js";

/** How many `deleteByPrefix` pages one purge may run before it gives up loudly. */
export const PURGE_MAX_PAGES = 1000;

/**
 * How long one purge may run. It runs inside the deletion request, so it has
 * to end well before a proxy gives up on that request. Past the deadline the
 * purge stops with a retryable error and keeps what it has deleted; the next
 * attempt carries on from there.
 */
export const PURGE_DEADLINE_MS = 45_000;

export interface UserUploadOptions {
  contentType: string;
  /** Exact byte length of the body. */
  size: number;
  /** Which content types this caller accepts. Required: there is no default. */
  contentTypePolicy: ContentTypePolicy;
  /** A cap below the store's own, for this purpose. It cannot raise the cap. */
  maxBytes?: number;
}

export interface UserStorage {
  put(
    userId: string,
    purpose: StoragePurpose,
    body: ObjectBody,
    options: UserUploadOptions,
  ): Promise<ObjectMeta>;
  get(userId: string, key: string): Promise<StoredObject | null>;
  head(userId: string, key: string): Promise<ObjectMeta | null>;
  delete(userId: string, key: string): Promise<void>;
  signedDownloadUrl(
    userId: string,
    key: string,
    options: SignedDownloadOptions,
  ): Promise<SignedDownload>;
  /** Remove every object under the user's prefix. Throws unless all of them went. */
  purgeUser(userId: string): Promise<{ deleted: number }>;
}

export interface UserStorageOptions {
  purgeMaxPages?: number;
  purgeDeadlineMs?: number;
}

interface PurgeBounds {
  maxPages: number;
  deadlineMs: number;
}

/** Apply the caller's own cap, when it gave one, on top of the store's. */
function withCallerCap(body: ObjectBody, size: number, maxBytes: number | undefined): ObjectBody {
  if (maxBytes === undefined) return body;
  assertUploadSize(size, maxBytes);
  return guardBytes(bodyChunks(body), { declaredSize: size, maxBytes });
}

async function purgePrefix(
  store: ObjectStore,
  prefix: string,
  bounds: PurgeBounds,
): Promise<{ deleted: number }> {
  // One deadline for the whole purge. The store drops a request in flight when
  // it fires, so the purge cannot outlive it by more than a moment.
  const signal = AbortSignal.timeout(bounds.deadlineMs);
  let deleted = 0;
  for (let page = 0; page < bounds.maxPages; page++) {
    if (signal.aborted) {
      throw new StorageError(
        "delete-incomplete",
        `purge stopped at its ${bounds.deadlineMs} ms deadline with ${deleted} objects deleted; retry to continue`,
        { retryable: true },
      );
    }
    const result = await store.deleteByPrefix(prefix, { signal });
    deleted += result.deleted;
    if (!result.more) return { deleted };
    if (result.deleted === 0) {
      throw new StorageError(
        "delete-incomplete",
        "object storage reported more objects but deleted none",
      );
    }
  }
  throw new StorageError(
    "delete-incomplete",
    `user prefix still holds objects after ${bounds.maxPages} delete pages (${deleted} deleted)`,
    { retryable: true },
  );
}

export function createUserStorage(
  store: ObjectStore,
  options: UserStorageOptions = {},
): UserStorage {
  const purgeBounds: PurgeBounds = {
    maxPages: options.purgeMaxPages ?? PURGE_MAX_PAGES,
    deadlineMs: options.purgeDeadlineMs ?? PURGE_DEADLINE_MS,
  };
  return {
    async put(userId, purpose, body, upload) {
      const key = newObjectKey(userId, purpose);
      const contentType = normalizeContentType(upload.contentType);
      if (!upload.contentTypePolicy(contentType)) {
        throw new StorageError(
          "content-type-refused",
          `content type ${contentType} is not accepted here`,
        );
      }
      const capped = withCallerCap(body, upload.size, upload.maxBytes);
      return await store.putObject(key, capped, { contentType, size: upload.size });
    },
    async get(userId, key) {
      assertKeyBelongsToUser(key, userId);
      return await store.getObject(key);
    },
    async head(userId, key) {
      assertKeyBelongsToUser(key, userId);
      return await store.headObject(key);
    },
    async delete(userId, key) {
      assertKeyBelongsToUser(key, userId);
      return await store.deleteObject(key);
    },
    async signedDownloadUrl(userId, key, download) {
      assertKeyBelongsToUser(key, userId);
      return await store.signedDownloadUrl(key, download);
    },
    async purgeUser(userId) {
      return await purgePrefix(store, userPrefix(userId), purgeBounds);
    },
  };
}
