/**
 * The two ways a user's data is deleted live here, so neither can drift:
 *
 *   - `deleteUserAndAllData`: the account goes (self-service and admin routes);
 *   - `purgeAllUserData`: the data goes, the account row stays
 *     (`DELETE /api/user/me/data`).
 *
 * Both start with the user's stored objects (`purgeUserObjects`, steps D1 and
 * D3 of docs/providers/unified-platform-plan.md), before any row goes. The user
 * id is the only handle on those objects, so with OBJECT_STORAGE_ENABLED on that
 * call first records a pending purge (StoragePurge, which outlives the rows),
 * then tries the bucket once. A bucket that fails no longer stops the deletion:
 * the hourly sweep finishes the purge (runbook in the plan's D3 entry). The call
 * throws, and no row goes, only when that record cannot be written. While
 * OBJECT_STORAGE_ENABLED is off the object step is a no-op.
 */

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
}

const PURGE_TX = { ...INTERACTIVE_TX_OPTIONS, timeout: PURGE_TX_TIMEOUT_MS } as const;
const FENCE_SECONDS = DATA_WIPE_FENCE_MS / 1000;

/** "purged" when the rows are gone; "pending" when the sweep must finish the purge. */
export type DataWipeOutcome = "purged" | "pending";

/**
 * Exhaustive user-data wipe that keeps the account row. See purge-user-data.ts:
 * the row list is CASA/Google "delete my data" critical and regression-tested.
 *
 * Fenced against everything already running for the user
 * (privacy/data-wipe-fence.ts):
 *   1. One short transaction holds the account row FOR UPDATE, records the
 *      wipe as pending and cuts off access (grants, automation config, API
 *      keys, credentials). From its commit on, the database rejects any insert
 *      into the account's data tables; an insert already in flight committed
 *      before it and is purged with the rest.
 *   2. The purge runs once and stamps the record purged, with the fence window.
 * If the purge fails, access is already gone and the fence holds until the
 * sweep (privacy/data-wipe-sweep.ts) finishes it, so the outcome is "pending",
 * not an error. Only a failure before step 1 committed throws.
 */
export async function purgeAllUserData(userId: string): Promise<DataWipeOutcome> {
  await purgeUserObjects(userId);
  const requestedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    await tx.dataWipe.upsert({
      where: { userId },
      create: { userId, requestedAt },
      update: { requestedAt, purgedAt: null, fenceUntil: null, attempts: 0 },
    });
    await revokeUserAccess(tx as unknown as typeof db, userId);
  }, PURGE_TX);
  rememberDataWipe(userId, { purgedAt: null, fenceUntil: null });
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
 * Purge every data row of a recorded wipe and stamp it purged, in one
 * transaction. Idempotent; the wipe and the sweep both call it.
 */
export async function finishDataWipe(userId: string): Promise<void> {
  const stamped = await prisma.$transaction(async (tx) => {
    await purgeUserData(tx as unknown as typeof db, userId);
    return tx.$queryRaw<{ purgedAt: Date; fenceUntil: Date }[]>`
      UPDATE "DataWipe"
      SET "purgedAt" = (now() AT TIME ZONE 'UTC'),
          "fenceUntil" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${FENCE_SECONDS}::double precision),
          "attempts" = "attempts" + 1,
          "updatedAt" = (now() AT TIME ZONE 'UTC')
      WHERE "userId" = ${userId}
      RETURNING "purgedAt", "fenceUntil"`;
  }, PURGE_TX);
  const row = stamped[0];
  if (row) rememberDataWipe(userId, row);
}
