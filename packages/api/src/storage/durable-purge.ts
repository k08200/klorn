/**
 * The durable account purge (step D3 of docs/providers/unified-platform-plan.md;
 * D1 review item M2). Loaded only while OBJECT_STORAGE_ENABLED is on: runtime.ts
 * imports this module dynamically, so with the flag off neither the record nor
 * the database is touched.
 *
 *   1. Record the pending purge (storage/purge-queue.ts). If this write fails the
 *      call throws and the deletion stops: nothing else would remember the
 *      objects once the rows are gone.
 *   2. Try the bucket once (one pass, bounded by PURGE_DEADLINE_MS).
 *   3. Record the outcome and resolve, whatever the bucket did. The account's
 *      rows go next; the hourly sweep (purge-sweep.ts) retries a failed pass
 *      with backoff and runs the late-object pass that finishes the record.
 *
 * Every failed pass is reported as before (`scope: storage.purge`), and from
 * PURGE_ALERT_AFTER_ATTEMPTS on also as `scope: storage.purge.stuck`.
 */

import { captureError } from "../sentry.js";
import { printableStorageError } from "./errors.js";
import {
  markPurgePending,
  PURGE_ALERT_AFTER_ATTEMPTS,
  recordPurgePassFailed,
  recordPurgePassSucceeded,
} from "./purge-queue.js";
import { getUserStorage } from "./runtime.js";

const LOG_PREFIX = "[STORAGE]";

export type PurgePassOutcome = "done" | "settling" | "failed";

export interface PurgePassResult {
  outcome: PurgePassOutcome;
  deleted: number;
}

type Attempt = { ok: true; deleted: number } | { ok: false; error: unknown };

/** One delete pass over the user's prefix. Never throws: a failure is an outcome. */
async function attemptPurge(userId: string): Promise<Attempt> {
  try {
    const storage = await getUserStorage();
    // Null only when the flag went off between the caller's check and now.
    if (!storage) return { ok: false, error: new Error("object storage is off") };
    const { deleted } = await storage.purgeUser(userId);
    return { ok: true, deleted };
  } catch (error) {
    return { ok: false, error };
  }
}

async function recordFailure(userId: string, error: unknown): Promise<void> {
  const { code, message, retryable } = printableStorageError(error);
  console.error(`${LOG_PREFIX} purge failed (${code}), the sweep retries it: ${message}`);
  captureError(error, {
    tags: { scope: "storage.purge", storageCode: code, retryable: String(retryable) },
  });
  const attempts = await recordPurgePassFailed(userId, code, new Date());
  if (attempts < PURGE_ALERT_AFTER_ATTEMPTS) return;
  console.error(
    `${LOG_PREFIX} purge still failing after ${attempts} attempts (${code}) for user ${userId}; ` +
      "see the D3 purge runbook",
  );
  captureError(error, {
    tags: { scope: "storage.purge.stuck", storageCode: code, attempts: String(attempts) },
    extra: { userId },
  });
}

/**
 * One pass, with its outcome recorded. Used by the deletion itself and by the
 * sweep. Throws only when the record cannot be written (a database failure).
 */
export async function runPurgePass(userId: string): Promise<PurgePassResult> {
  const startedAt = new Date();
  const attempt = await attemptPurge(userId);
  if (!attempt.ok) {
    await recordFailure(userId, attempt.error);
    return { outcome: "failed", deleted: 0 };
  }
  const outcome = await recordPurgePassSucceeded(userId, startedAt);
  return { outcome, deleted: attempt.deleted };
}

/** The deletion's own purge: record first, then one pass. See the header. */
export async function purgeUserObjectsDurably(userId: string): Promise<PurgePassResult> {
  await markPurgePending(userId, new Date());
  return await runPurgePass(userId);
}
