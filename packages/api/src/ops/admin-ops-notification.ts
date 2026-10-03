/**
 * Ops alert recipient path — one `ops` Notification row per ADMIN user.
 *
 * Extracted from the cost-cap trip alert (billing/cost-trip-alert.ts) so the
 * judge fallback alarm (judge/judge-health.ts) reaches the same people through
 * the same channel. Dedupe is the caller's `dedupeKey` against the
 * (userId, dedupeKey) unique index: a P2002 means another instance already won
 * that create — the winner-only idiom of ensureDailyBriefingNotification.
 */

export interface AdminOpsNotificationInput {
  dedupeKey: string;
  title: string;
  message: string;
}

const PRISMA_UNIQUE_VIOLATION = "P2002";

export interface AdminOpsDelivery {
  /** ADMIN users found. 0 means nobody can receive an in-app ops alert. */
  recipients: number;
  /** Rows THIS call created; 0 with recipients > 0 means already sent (dedupe). */
  created: number;
}

/**
 * Create the notification for every ADMIN. Any failure other than a lost
 * dedupe race is rethrown for the caller to log.
 */
export async function createAdminOpsNotifications(
  input: AdminOpsNotificationInput,
): Promise<AdminOpsDelivery> {
  // Lazy db import: keeps callers off the Prisma .env-autoload init path
  // (same reason cents.ts exists — see the header comment there).
  const { prisma } = await import("../db.js");
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN" },
    select: { id: true },
  });

  let created = 0;
  for (const admin of admins) {
    try {
      await prisma.notification.create({
        data: {
          userId: admin.id,
          type: "ops",
          dedupeKey: input.dedupeKey,
          title: input.title,
          message: input.message,
        },
      });
      created += 1;
    } catch (err) {
      if ((err as { code?: string })?.code !== PRISMA_UNIQUE_VIOLATION) throw err;
    }
  }
  return { recipients: admins.length, created };
}
