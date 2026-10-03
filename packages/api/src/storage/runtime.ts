/**
 * The flag gate around object storage (step D1 of
 * docs/providers/unified-platform-plan.md). Everything outside `storage/`
 * reaches a store through this file.
 *
 * OBJECT_STORAGE_ENABLED off (the default): no client is built, no
 * OBJECT_STORAGE_* variable is read, nothing connects, and the purge skips.
 *
 * On: the config is validated when the process starts and again on first use.
 * A bad config does not stop the process. Storage is auxiliary and the mail
 * product must keep serving. It is reported by variable name, and every storage
 * call then fails with `misconfigured` until it is fixed.
 */

import { objectStorageEnabled } from "../config.js";
import { captureError } from "../sentry.js";
import { StorageError, type StorageErrorCode } from "./errors.js";
import type { ObjectStore } from "./object-store.js";
import { readS3StoreConfig, type S3StoreConfig } from "./s3-config.js";
import { S3ObjectStore } from "./s3-store.js";
import { createUserStorage, type UserStorage } from "./user-storage.js";

const LOG_PREFIX = "[STORAGE]";

let cachedStore: ObjectStore | null = null;

/**
 * The store, or null while the flag is off. Throws `misconfigured` when the
 * flag is on and the environment is not usable. The flag is read on every call.
 */
export function getObjectStore(): ObjectStore | null {
  if (!objectStorageEnabled()) return null;
  cachedStore ??= new S3ObjectStore(readS3StoreConfig());
  return cachedStore;
}

/** The user-scoped layer over the store, or null while the flag is off. */
export function getUserStorage(): UserStorage | null {
  const store = getObjectStore();
  return store ? createUserStorage(store) : null;
}

/** Replace (or, with null, forget) the store. Tests only. */
export function setObjectStoreForTests(store: ObjectStore | null): void {
  cachedStore = store;
}

export type StorageHealth =
  | { state: "disabled" }
  | { state: "ok"; bucket: string; host: string }
  | { state: "misconfigured" | "failing"; code: StorageErrorCode; message: string };

function report(state: "misconfigured" | "failing", err: unknown): StorageHealth {
  const code = err instanceof StorageError ? err.code : "upstream";
  // A StorageError message is built from variable names, HTTP statuses and the
  // vendor's error code. Anything else is not trusted to be free of secrets.
  const message = err instanceof StorageError ? err.message : "unexpected error during the check";
  console.error(`${LOG_PREFIX} ${state} (${code}): ${message}`);
  captureError(err, { tags: { context: "startup:object-storage", storageCode: code } });
  return { state, code, message };
}

function readConfigOrReport(): S3StoreConfig | StorageHealth {
  try {
    return readS3StoreConfig();
  } catch (err) {
    return report("misconfigured", err);
  }
}

/**
 * The startup check. Never throws and never stops the boot. Off: does nothing.
 * On: validates the config, then lists one key to prove the endpoint, the
 * bucket and the token's permission. Logs the bucket and host, never a key.
 */
export async function checkObjectStorageAtStartup(): Promise<StorageHealth> {
  if (!objectStorageEnabled()) return { state: "disabled" };
  const config = readConfigOrReport();
  if ("state" in config) return config;
  try {
    const store = getObjectStore();
    await store?.ping();
  } catch (err) {
    return report("failing", err);
  }
  const host = new URL(config.endpoint).host;
  console.log(`${LOG_PREFIX} ok: bucket ${config.bucket} on ${host} is reachable`);
  return { state: "ok", bucket: config.bucket, host };
}

export interface PurgeObjectsResult {
  /** True when the flag is off and storage was not touched. */
  skipped: boolean;
  deleted: number;
}

/**
 * Delete every object a user owns. Called BEFORE the database rows go, by both
 * deletion paths (`user-deletion.ts`).
 *
 * It blocks: if the bucket cannot be reached, is misconfigured, or keeps
 * objects, this throws and the caller must not delete the rows. A deletion
 * request is never answered "done" while the user's files may still exist, and
 * the user id (the only handle on those files) is not lost. Deleting is
 * idempotent, so the request is simply retried.
 */
export async function purgeUserObjects(userId: string): Promise<PurgeObjectsResult> {
  const storage = getUserStorage();
  if (!storage) return { skipped: true, deleted: 0 };
  const { deleted } = await storage.purgeUser(userId);
  return { skipped: false, deleted };
}
