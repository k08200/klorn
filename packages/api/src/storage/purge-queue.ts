/**
 * The durable pending-purge record (step D3 of
 * docs/providers/unified-platform-plan.md; deferred from D1's review).
 *
 * One StoragePurge row per account whose objects are still to be deleted. It is
 * written when a deletion starts (OBJECT_STORAGE_ENABLED on), BEFORE storage is
 * touched, and has no foreign key to the user: once it exists, the account's
 * database rows may go even while the bucket is down, because this row keeps the
 * user id, the one handle on `u/<userId>/`.
 *
 * Finishing it. An upload that was already running when the deletion started can
 * still land an object after the first pass emptied the prefix. So a record is
 * finished only by a pass that STARTED at least LATE_UPLOAD_GRACE_MS after the
 * latest request and found the prefix empty. While a record exists, the drive
 * refuses new uploads for that user (`isStoragePurgePending`).
 *
 * Only the purge path (storage/durable-purge.ts) and the sweep call the writers
 * here. The record holds an error CODE, never a message or a key.
 */

import { prisma } from "../db.js";

/**
 * How long after a deletion request an object may still land. One upload is one
 * PUT, and the S3 store gives a PUT at most 120 s (its transfer timeout); the
 * drive re-checks the record right before that PUT starts and again after it.
 * Five times that bound leaves room for a slow row write and clock skew.
 */
export const LATE_UPLOAD_GRACE_MS = 10 * 60_000;

/** The first retry waits one sweep interval; each failure doubles the wait. */
export const PURGE_RETRY_BASE_MS = 60 * 60_000;
/** The longest wait between two attempts: one a day, until the prefix is empty. */
export const PURGE_RETRY_MAX_MS = 24 * 60 * 60_000;

/**
 * From this many failed passes on, every further failure also raises its own
 * alert (`scope: storage.purge.stuck`): three hours or more of a bucket that
 * keeps refusing is not an outage that passes on its own.
 */
export const PURGE_ALERT_AFTER_ATTEMPTS = 3;

/** The wait after the `attempts`-th failed pass (1-based). */
export function purgeRetryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 30));
  return Math.min(PURGE_RETRY_BASE_MS * 2 ** exponent, PURGE_RETRY_MAX_MS);
}

/**
 * Record (or refresh) the pending purge of this user, due at once. A refresh
 * restarts the late-upload grace and keeps the failure history. Throws when the
 * database does: the caller must then not delete any row, or the handle is lost.
 */
export async function markPurgePending(userId: string, now: Date): Promise<void> {
  await prisma.storagePurge.upsert({
    where: { userId },
    create: { userId, requestedAt: now, nextAttemptAt: now },
    update: { requestedAt: now, nextAttemptAt: now },
  });
}

/** True while this user's objects are being deleted: uploads must be refused. */
export async function isStoragePurgePending(userId: string): Promise<boolean> {
  const row = await prisma.storagePurge.findUnique({
    where: { userId },
    select: { userId: true },
  });
  return row !== null;
}

/**
 * A pass that started at `passStartedAt` emptied the prefix. It resets the
 * failure count, so the stuck alert counts consecutive failures. "done" when that pass
 * started after the grace of the latest request (the record is deleted in the
 * same statement that checks it, so a newer request is never finished by an
 * older pass); otherwise "settling", due again once this pass's grace is over.
 */
export async function recordPurgePassSucceeded(
  userId: string,
  passStartedAt: Date,
): Promise<"done" | "settling"> {
  const graceStart = new Date(passStartedAt.getTime() - LATE_UPLOAD_GRACE_MS);
  const finished = await prisma.storagePurge.deleteMany({
    where: { userId, requestedAt: { lte: graceStart } },
  });
  if (finished.count > 0) return "done";
  const settling = await prisma.storagePurge.updateMany({
    where: { userId },
    data: {
      attempts: 0,
      lastError: null,
      nextAttemptAt: new Date(passStartedAt.getTime() + LATE_UPLOAD_GRACE_MS),
    },
  });
  return settling.count > 0 ? "settling" : "done";
}

/**
 * A pass failed with this StorageError code. Counts the attempt and schedules
 * the next one with backoff. Answers the attempts so far (0 when the record is
 * gone, which only a finished purge does).
 */
export async function recordPurgePassFailed(
  userId: string,
  code: string,
  now: Date,
): Promise<number> {
  const row = await prisma.storagePurge.findUnique({
    where: { userId },
    select: { attempts: true },
  });
  if (row === null) return 0;
  const attempts = row.attempts + 1;
  const written = await prisma.storagePurge.updateMany({
    where: { userId },
    data: {
      attempts,
      lastError: code,
      nextAttemptAt: new Date(now.getTime() + purgeRetryDelayMs(attempts)),
    },
  });
  return written.count > 0 ? attempts : 0;
}

/** How many purges are pending: a count only, no user id leaves this function. */
export async function countPendingPurges(): Promise<number> {
  return await prisma.storagePurge.count();
}

/** The users whose purge is due, the longest-waiting first, at most `limit`. */
export async function duePurges(now: Date, limit: number): Promise<string[]> {
  const rows = await prisma.storagePurge.findMany({
    where: { nextAttemptAt: { lte: now } },
    orderBy: [{ nextAttemptAt: "asc" }, { userId: "asc" }],
    take: limit,
    select: { userId: true },
  });
  return rows.map((row) => row.userId);
}
