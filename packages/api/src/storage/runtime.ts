/**
 * The flag gate around object storage (step D1 of
 * docs/providers/unified-platform-plan.md). Everything outside `storage/`
 * reaches a store through this file, and later steps stay on `getUserStorage()`:
 * the raw store has no notion of who owns a key.
 *
 * OBJECT_STORAGE_ENABLED off (the default): the S3 implementation and its
 * signing library are never loaded, no client is built, nothing connects, and
 * the purge skips. The startup check only looks at whether the storage
 * variables are set, to warn about the one dangerous combination.
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
import { readS3StoreConfig, S3_ENV_NAMES } from "./s3-config.js";
import { createUserStorage, type UserStorage } from "./user-storage.js";

const LOG_PREFIX = "[STORAGE]";

/** Set while the flag is off, these mean a bucket was (or is about to be) in use. */
const VARIABLES_THAT_IMPLY_A_BUCKET = [
  S3_ENV_NAMES.endpoint,
  S3_ENV_NAMES.bucket,
  S3_ENV_NAMES.accessKeyId,
  S3_ENV_NAMES.secretAccessKey,
] as const;

let cachedStore: ObjectStore | null = null;
let building: Promise<ObjectStore> | null = null;

/**
 * Build the store. The config is read first, so a bad one fails before the S3
 * implementation is loaded. The import is dynamic on purpose: a process with
 * the flag off never loads `s3-store.ts` or `aws4fetch`.
 */
async function buildStore(): Promise<ObjectStore> {
  const config = readS3StoreConfig();
  const { S3ObjectStore } = await import("./s3-store.js");
  return new S3ObjectStore(config);
}

/**
 * The store, or null while the flag is off. Rejects with `misconfigured` when
 * the flag is on and the environment is not usable. The flag is read on every
 * call.
 */
export async function getObjectStore(): Promise<ObjectStore | null> {
  if (!objectStorageEnabled()) return null;
  if (cachedStore) return cachedStore;
  building ??= buildStore();
  try {
    cachedStore = await building;
  } finally {
    building = null;
  }
  return cachedStore;
}

/**
 * The user-scoped layer over the store, or null while the flag is off. This is
 * the entry point for D3, D4 and E4: every call names the user it acts for.
 */
export async function getUserStorage(): Promise<UserStorage | null> {
  const store = await getObjectStore();
  return store ? createUserStorage(store) : null;
}

/** Replace (or, with null, forget) the store. Tests only. */
export function setObjectStoreForTests(store: ObjectStore | null): void {
  cachedStore = store;
}

export type StorageHealth =
  | { state: "disabled" }
  | { state: "ok" }
  | { state: "misconfigured" | "failing"; code: StorageErrorCode; message: string };

/** The parts of an error that are safe to print and to tag. */
function printable(err: unknown): { code: StorageErrorCode; message: string; retryable: boolean } {
  // A StorageError message is built from variable names, HTTP statuses and the
  // vendor's error code. Anything else is not trusted to be free of secrets.
  if (err instanceof StorageError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  return { code: "upstream", message: "unexpected error", retryable: false };
}

function report(state: "misconfigured" | "failing", err: unknown): StorageHealth {
  const { code, message } = printable(err);
  console.error(`${LOG_PREFIX} ${state} (${code}): ${message}`);
  captureError(err, { tags: { scope: "storage.startup", storageCode: code } });
  return { state, code, message };
}

/**
 * The flag is off but a bucket is configured. If objects were ever written,
 * deleting an account now leaves them behind without a word, so say it at
 * startup. Names only: whether a variable is set, never what it holds.
 */
function warnIfConfiguredWhileOff(): void {
  const set = VARIABLES_THAT_IMPLY_A_BUCKET.filter((name) => (process.env[name] ?? "").trim());
  if (set.length === 0) return;
  console.warn(
    `${LOG_PREFIX} OBJECT_STORAGE_ENABLED is off but ${set.join(", ")} ${set.length === 1 ? "is" : "are"} set. ` +
      "While it is off, deleting an account does NOT delete stored objects. " +
      "If the bucket holds any, turn the flag back on; otherwise remove these variables.",
  );
}

/**
 * The startup check. Never throws and never stops the boot. Off: warns if a
 * bucket is configured anyway, and does nothing else. On: validates the config,
 * then lists one key to prove the endpoint, the bucket and the token's
 * permission. The success line names nothing: an R2 host contains the account id.
 */
export async function checkObjectStorageAtStartup(): Promise<StorageHealth> {
  if (!objectStorageEnabled()) {
    warnIfConfiguredWhileOff();
    return { state: "disabled" };
  }
  try {
    readS3StoreConfig();
  } catch (err) {
    return report("misconfigured", err);
  }
  try {
    const store = await getObjectStore();
    await store?.ping();
  } catch (err) {
    return report("failing", err);
  }
  console.log(`${LOG_PREFIX} ok: the startup check passed`);
  return { state: "ok" };
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
 *
 * A blocked deletion is reported under its own Sentry tag,
 * `scope: storage.purge`, with the error code and whether a retry may pass, so
 * an alert can be built on it. The runbook is in the plan's D1 entry.
 */
export async function purgeUserObjects(userId: string): Promise<PurgeObjectsResult> {
  try {
    // Null while the flag is off: storage is then not touched at all.
    const storage = await getUserStorage();
    if (!storage) return { skipped: true, deleted: 0 };
    const { deleted } = await storage.purgeUser(userId);
    return { skipped: false, deleted };
  } catch (err) {
    const { code, message, retryable } = printable(err);
    console.error(`${LOG_PREFIX} purge blocked (${code}): ${message}`);
    captureError(err, {
      tags: { scope: "storage.purge", storageCode: code, retryable: String(retryable) },
    });
    throw err;
  }
}
