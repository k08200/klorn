/**
 * The two ways a user's data is deleted live here, so neither can drift:
 *
 *   - `deleteUserAndAllData`: the account goes (self-service and admin routes);
 *   - `purgeAllUserData`: the data goes, the account row stays
 *     (`DELETE /api/user/me/data`).
 *
 * Both delete the user's stored objects (`purgeUserObjects`, steps D1 and D3 of
 * docs/providers/unified-platform-plan.md) before any data row goes; the data
 * wipe does it right after it records the wipe and cuts off access, so no
 * upload can land in between. The user
 * id is the only handle on those objects, so with OBJECT_STORAGE_ENABLED on that
 * call first records a pending purge (StoragePurge, which outlives the rows),
 * then tries the bucket once. A bucket that fails no longer stops the deletion:
 * the hourly sweep finishes the purge (runbook in the plan's D3 entry). The call
 * throws, and no row goes, only when that record cannot be written. While
 * OBJECT_STORAGE_ENABLED is off the object step is a no-op.
 */

import {
  collectGoogleGrants,
  type HeldGoogleGrant,
  revokeGoogleGrants,
} from "./auth/google-grant-revoke.js";
import { type db, INTERACTIVE_TX_OPTIONS, prisma } from "./db.js";
import { DATA_WIPE_FENCE_MS, rememberDataWipe } from "./privacy/data-wipe-fence.js";
import { purgeUserData, revokeUserAccess } from "./purge-user-data.js";
import { captureError } from "./sentry.js";
import { purgeUserObjects } from "./storage/runtime.js";

/**
 * A full purge of a large account is many deletes and must not die at the 5s
 * interactive default on a compliance-critical endpoint.
 */
const PURGE_TX_TIMEOUT_MS = 60_000;

/**
 * Delete a user and ALL of their data. Single source of truth so the
 * self-service account-deletion route and the admin delete-user route can never
 * drift apart (Google restricted-scope review requires users to be able to
 * request full deletion of their data, incl. all Google-derived data).
 *
 * Completeness: every user-scoped relation but one declares `onDelete: Cascade`,
 * so deleting the `User` row removes them automatically (emails, attention
 * items, attachments, sender traits, linked accounts, devices, etc.). The one
 * exception is `LlmUsageLog`, whose `userId` is `onDelete: SetNull` (it
 * anonymizes rather than blocks) — we delete it explicitly first so account
 * deletion leaves nothing tied to the user, not even an anonymized usage row.
 */
export async function deleteUserAndAllData(userId: string): Promise<void> {
  await purgeUserObjects(userId);
  const grants = await googleGrantsBeforeRemoval(userId);
  const email = (await prisma.user.findUnique({ where: { id: userId }, select: { email: true } }))
    ?.email;
  await prisma.$transaction([
    prisma.llmUsageLog.deleteMany({ where: { userId } }),
    // The waitlist is keyed by address, not by user, so no cascade reaches it.
    // Exact matches only: an insensitive filter is ILIKE, where "_" in an
    // address is a wildcard that could match someone else's entry.
    ...(email
      ? [prisma.waitlist.deleteMany({ where: { email: { in: [email, email.toLowerCase()] } } })]
      : []),
    prisma.user.delete({ where: { id: userId } }),
  ]);
  // The account is gone: revoke its Google grants at Google (best effort, not
  // awaited, so Google's latency never holds the request).
  void revokeGoogleGrants(userId, grants);
}

/**
 * The user's Google grants, read before their rows go, so they can be revoked
 * at Google afterwards (auth/google-grant-revoke.ts). A failed read costs the
 * revoke, never the deletion.
 */
async function googleGrantsBeforeRemoval(userId: string): Promise<HeldGoogleGrant[]> {
  try {
    return await collectGoogleGrants(userId);
  } catch (err) {
    console.error(`[USER-DELETION] Could not read ${userId}'s Google grants to revoke:`, err);
    captureError(err, { tags: { scope: "user-deletion.google-grants", userId } });
    return [];
  }
}

// A function, not a constant: tests that mock db.js without the options still
// import this module (through routes/auth.ts).
const purgeTx = () => ({ ...INTERACTIVE_TX_OPTIONS, timeout: PURGE_TX_TIMEOUT_MS });
const FENCE_SECONDS = DATA_WIPE_FENCE_MS / 1000;

/** "purged" when the rows are gone; "pending" when the sweep must finish the purge. */
export type DataWipeOutcome = "purged" | "pending";

/** What finishing a recorded wipe did. */
export type FinishOutcome = "purged" | "not-pending";

const RECORD_ATTEMPTS = 3;

/** A deadlock (40P01) or write conflict Postgres resolved by aborting this side. */
function isRetryableConflict(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  const message = err instanceof Error ? err.message : "";
  return code === "P2034" || /deadlock detected|40P01/.test(message);
}

/**
 * Lock the account row, record the wipe as pending and cut off access, in one
 * short transaction. A writer that holds one of the grant rows and then
 * inserts a fenced row can deadlock with it; Postgres aborts one side, so a
 * conflict is retried.
 */
async function recordWipeAndRevoke(userId: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const requestedAt = new Date();
      await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<
          unknown[]
        >`SELECT 1 FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
        // Zero rows would mean no lock, and so no serialization with the trigger.
        if (locked.length !== 1) throw new Error("data wipe: the account row could not be locked");
        await tx.dataWipe.upsert({
          where: { userId },
          create: { userId, requestedAt },
          update: { requestedAt, purgedAt: null, fenceUntil: null, attempts: 0 },
        });
        await revokeUserAccess(tx as unknown as typeof db, userId);
      }, purgeTx());
      return;
    } catch (err) {
      if (attempt >= RECORD_ATTEMPTS || !isRetryableConflict(err)) throw err;
    }
  }
}

/**
 * Exhaustive user-data wipe that keeps the account row. See purge-user-data.ts:
 * the row list is CASA/Google "delete my data" critical and regression-tested.
 *
 * Fenced against everything already running for the user
 * (privacy/data-wipe-fence.ts):
 *   1. One short transaction holds the account row FOR UPDATE, records the
 *      wipe as pending and cuts off access (grants, automation config, API
 *      keys, credentials); the Google grants are then revoked at Google
 *      (auth/google-grant-revoke.ts). From its commit on, the database rejects any insert
 *      into the account's data tables; an insert already in flight committed
 *      before it and is purged with the rest.
 *   2. The stored objects go (steps D1/D3), then the purge runs once and
 *      stamps the record purged, with the fence window.
 * If step 2 fails, access is already gone and the fence holds until the sweep
 * (privacy/data-wipe-sweep.ts) finishes it, so the outcome is "pending", not
 * an error. Only a failure before step 1 committed throws.
 */
export async function purgeAllUserData(userId: string): Promise<DataWipeOutcome> {
  const grants = await googleGrantsBeforeRemoval(userId);
  await recordWipeAndRevoke(userId);
  rememberDataWipe(userId, { purgedAt: null, fenceUntil: null });
  // Access is cut off in Klorn; revoke the grants at Google too (best effort,
  // not awaited: the purge must not wait on Google).
  void revokeGoogleGrants(userId, grants);
  try {
    await finishDataWipe(userId);
    return "purged";
  } catch (err) {
    console.error(
      `[USER-DELETION] Data wipe purge failed for ${userId}; the sweep finishes it:`,
      err,
    );
    captureError(err, { tags: { scope: "user-deletion.purge", userId } });
    return "pending";
  }
}

/**
 * Finish a recorded wipe: delete the stored objects, then purge every data row
 * and stamp the record purged, in one transaction that holds the record FOR
 * UPDATE. A wipe that is no longer pending (finished by its request, by
 * another sweep, or already followed by new data) is left alone: purging it
 * again would delete what the user created since. The wipe and the sweep both
 * call it.
 */
export async function finishDataWipe(userId: string): Promise<FinishOutcome> {
  // Checked before the bucket too: purging a finished wipe's objects would
  // delete what the user stored since. Checked again under the lock below.
  const record = await prisma.dataWipe.findUnique({
    where: { userId },
    select: { purgedAt: true },
  });
  if (!record || record.purgedAt !== null) return "not-pending";
  await purgeUserObjects(userId);
  const stamped = await prisma.$transaction(async (tx) => {
    const pending = await tx.$queryRaw<unknown[]>`
      SELECT 1 FROM "DataWipe" WHERE "userId" = ${userId} AND "purgedAt" IS NULL FOR UPDATE`;
    if (pending.length === 0) return null;
    await purgeUserData(tx as unknown as typeof db, userId);
    // clock_timestamp, not now(): the window starts when the purge is done,
    // not when its transaction began.
    const [row] = await tx.$queryRaw<{ purgedAt: Date; fenceUntil: Date }[]>`
      UPDATE "DataWipe"
      SET "purgedAt" = (clock_timestamp() AT TIME ZONE 'UTC'),
          "fenceUntil" = (clock_timestamp() AT TIME ZONE 'UTC') + make_interval(secs => ${FENCE_SECONDS}::double precision),
          "attempts" = "attempts" + 1,
          "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE "userId" = ${userId}
      RETURNING "purgedAt", "fenceUntil"`;
    return row ?? null;
  }, purgeTx());
  if (!stamped) return "not-pending";
  rememberDataWipe(userId, stamped);
  return "purged";
}
