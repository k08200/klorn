/**
 * Zombie web-push subscriptions.
 *
 * A push service can keep answering 201 for an endpoint whose browser never
 * shows anything again (profile gone, service worker broken, app uninstalled
 * from the Home Screen). Eviction on 404/410 (push.ts) never fires for those,
 * so the row lives forever and the person believes they have alerts.
 *
 * The signal is the service worker's receipt: after ZOMBIE_MIN_UNRECEIPTED_PUSHES
 * accepted pushes in a row with no receipt, the oldest at least
 * ZOMBIE_MIN_SPAN_MS old, the subscription is flagged `needsResubscribeAt`. The
 * web app then offers to turn alerts back on (a click — gesture only, #1716),
 * which replaces the endpoint. With PUSH_ZOMBIE_EVICTION on, sendPushNotification
 * also stops sending to a flagged subscription. Any receipt on the
 * subscription — a "Send test" that arrives included — clears the flag.
 *
 * Thresholds (2026-11-12, from aggregate production delivery logs): the
 * longest receipt gap a subscription later recovered from was just under 10
 * accepted pushes over just under 7 days (a laptop browser that was not
 * running). 10 pushes / 7 days would sit right on that gap, so the threshold
 * takes about twice it on both axes. Rows younger than RECEIPT_GRACE_MS are
 * not counted: their receipt may still be in flight.
 *
 * Only meaningful when pushes carry a receipt URL (PUSH_RECEIPT_BASE_URL or
 * RENDER_EXTERNAL_URL); push.ts does not evaluate otherwise, or every
 * subscription of a deployment without receipts would look dead.
 */

import { prisma } from "../db.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const ZOMBIE_MIN_UNRECEIPTED_PUSHES = 20;
export const ZOMBIE_MIN_SPAN_MS = 14 * DAY_MS;
export const RECEIPT_GRACE_MS = 60 * 60 * 1000;

export function isZombieRun(input: {
  unreceipted: number;
  oldestUnreceiptedAt: Date | null;
  now: number;
}): boolean {
  const { unreceipted, oldestUnreceiptedAt, now } = input;
  if (unreceipted < ZOMBIE_MIN_UNRECEIPTED_PUSHES || !oldestUnreceiptedAt) return false;
  return now - oldestUnreceiptedAt.getTime() >= ZOMBIE_MIN_SPAN_MS;
}

/**
 * Flag the subscription when its pushes since the last receipt make a zombie
 * run. Returns whether it is (now or already) a zombie. Keeps the first flag
 * time when it was already flagged.
 */
export async function evaluateZombieSubscription(
  subscriptionId: string,
  now: Date = new Date(),
  endpointSince: Date | null = null,
): Promise<boolean> {
  const lastReceipted = await lastReceiptedAt(subscriptionId);
  // The run starts after the last receipt, and never before the endpoint's
  // current value existed (a rotation or re-subscribe restarts it).
  const since = Math.max(lastReceipted?.getTime() ?? 0, endpointSince?.getTime() ?? 0);
  const run = await prisma.pushDeliveryLog.aggregate({
    where: {
      subscriptionId,
      channel: "web",
      status: "ACCEPTED",
      receivedAt: null,
      clickedAt: null,
      createdAt: { gt: new Date(since), lt: new Date(now.getTime() - RECEIPT_GRACE_MS) },
    },
    _count: { _all: true },
    _min: { createdAt: true },
  });
  const zombie = isZombieRun({
    unreceipted: run._count._all,
    oldestUnreceiptedAt: run._min.createdAt,
    now: now.getTime(),
  });
  if (!zombie) return false;
  const flagged = await prisma.pushSubscription.updateMany({
    where: { id: subscriptionId, needsResubscribeAt: null },
    data: { needsResubscribeAt: now },
  });
  if (flagged.count === 0) return true;
  // A receipt that landed between the read above and the flag (a device
  // draining queued pushes as it wakes) cleared nothing yet: undo the flag.
  const after = await lastReceiptedAt(subscriptionId);
  if (after && after.getTime() !== (lastReceipted?.getTime() ?? -1)) {
    await clearZombieFlag(subscriptionId);
    return false;
  }
  console.log(
    `[PUSH] Subscription ${subscriptionId} needs re-subscribe: ${run._count._all} accepted pushes with no receipt`,
  );
  return true;
}

async function lastReceiptedAt(subscriptionId: string): Promise<Date | null> {
  const row = await prisma.pushDeliveryLog.findFirst({
    where: {
      subscriptionId,
      channel: "web",
      OR: [{ receivedAt: { not: null } }, { clickedAt: { not: null } }],
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}

/** A receipt proves the subscription works again. */
export async function clearZombieFlag(subscriptionId: string): Promise<void> {
  await prisma.pushSubscription.updateMany({
    where: { id: subscriptionId, needsResubscribeAt: { not: null } },
    data: { needsResubscribeAt: null },
  });
}
