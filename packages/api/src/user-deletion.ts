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
import { purgeUserData } from "./purge-user-data.js";
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
  await prisma.$transaction([
    prisma.llmUsageLog.deleteMany({ where: { userId } }),
    prisma.user.delete({ where: { id: userId } }),
  ]);
}

/**
 * Exhaustive user-data wipe that keeps the account row. See purge-user-data.ts:
 * the row list is CASA/Google "delete my data" critical and regression-tested.
 * Pool-sized maxWait (#845 P2028 class) plus a 60s timeout of its own.
 */
export async function purgeAllUserData(userId: string): Promise<void> {
  await purgeUserObjects(userId);
  await prisma.$transaction((tx) => purgeUserData(tx as unknown as typeof db, userId), {
    ...INTERACTIVE_TX_OPTIONS,
    timeout: PURGE_TX_TIMEOUT_MS,
  });
}
