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
import { printableStorageError, type StorageErrorCode } from "./errors.js";
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

function report(state: "misconfigured" | "failing", err: unknown): StorageHealth {
  const { code, message } = printableStorageError(err);
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

/**
 * What a purge did. Off: `{ skipped: true, deleted: 0 }`, exactly as in D1. On:
 * the outcome of the first pass ("failed" included: the deletion goes on, and
 * the pending record lets the sweep finish the job).
 */
export type PurgeObjectsResult =
  | { skipped: true; deleted: 0 }
  | { skipped: false; deleted: number; outcome: "done" | "settling" | "failed" };

/**
 * Delete every object a user owns. Called BEFORE the database rows go, by both
 * deletion paths (`user-deletion.ts`).
 *
 * Off: storage, the purge record and the database are not touched at all.
 *
 * On (step D3, replacing D1's blocking purge): the pending purge is recorded
 * first (StoragePurge), then one pass runs, and the call resolves whatever the
 * bucket did. A bucket that is down no longer blocks a deletion: the record
 * keeps the user id, the one handle on the objects, and the hourly sweep
 * (`purge-sweep.ts`) retries with backoff until a pass that started after the
 * late-upload grace finds the prefix empty. While the record exists the drive
 * refuses uploads for the user. The call still throws when the record cannot be
 * written, and the caller then deletes no row. A failed pass is reported under
 * `scope: storage.purge`, a purge that keeps failing under
 * `scope: storage.purge.stuck` (runbook in the plan's D3 entry).
 */
export async function purgeUserObjects(userId: string): Promise<PurgeObjectsResult> {
  if (!objectStorageEnabled()) return { skipped: true, deleted: 0 };
  // Loaded only now, like the S3 implementation: a process with the flag off
  // never loads the purge record's module.
  const { purgeUserObjectsDurably } = await import("./durable-purge.js");
  const { outcome, deleted } = await purgeUserObjectsDurably(userId);
  return { skipped: false, deleted, outcome };
}
