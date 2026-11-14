/**
 * What an account deletion does to the account's organization. A member's
 * membership and grant cascade away with the account. An OWNER steps out and
 * hands the organization to its longest-standing member, in one locked
 * transaction (org-lock.ts), so the organization never has two owners or
 * none. An organization left with no member is deleted, unless it still has a
 * live team subscription: that is canceled at the period end (and kept until
 * Paddle's webhook says so), never silently left billing.
 *
 * The organization's audit and invite rows keep their history but stop
 * naming the deleted account (its user id is cleared).
 *
 * Runs whatever TEAMS_ENABLED says: rows made while the flag was on must
 * still get an owner when that owner deletes their account.
 */

import { cancelPaddleSubscription } from "../billing/paddle.js";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";
import { recordOrgAudit } from "./audit.js";
import { subscriptionBills } from "./effective-tier.js";
import { isOrgError } from "./org-error.js";
import { type OrgTx, withOrgLock } from "./org-lock.js";

/** The Paddle subscription an organization was left holding with no member, if any. */
async function handOver(tx: OrgTx, userId: string, orgId: string): Promise<string | null> {
  const mine = await tx.orgMembership.findUnique({ where: { userId }, select: { role: true } });
  if (mine?.role !== "OWNER") return null;
  const successor = await tx.orgMembership.findFirst({
    where: { orgId, userId: { not: userId } },
    orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
    select: { id: true, userId: true },
  });
  if (successor) {
    await tx.orgMembership.deleteMany({ where: { userId } });
    await tx.availabilityGrant.deleteMany({ where: { userId } });
    await tx.orgMembership.update({
      where: { id: successor.id },
      data: { role: "OWNER" },
      select: { id: true },
    });
    await recordOrgAudit(tx, {
      orgId,
      action: "owner.succeeded",
      actorUserId: null,
      targetUserId: successor.userId,
    });
    return null;
  }
  const org = await tx.organization.findUnique({
    where: { id: orgId },
    select: { subscriptionStatus: true, paddleSubscriptionId: true },
  });
  if (subscriptionBills(org?.subscriptionStatus)) {
    // Kept until Paddle's cancellation webhook lands on it.
    if (org?.paddleSubscriptionId) return org.paddleSubscriptionId;
    captureError(new Error("billing organization lost its last member with no subscription id"), {
      tags: { scope: "org.account-deletion" },
      extra: { orgId },
    });
    return null;
  }
  await tx.organization.delete({ where: { id: orgId }, select: { id: true } });
  return null;
}

/**
 * The last member deleted their account: stop the team subscription at the end
 * of the paid period (the refund policy's terms). A failure is reported for
 * the founder to cancel by hand; it never blocks the account deletion.
 */
async function cancelOrphanedSubscription(orgId: string, subscriptionId: string): Promise<void> {
  try {
    await cancelPaddleSubscription(subscriptionId);
  } catch (err) {
    captureError(err, {
      tags: { scope: "org.account-deletion" },
      extra: { orgId, note: "team subscription left without members; cancel it in Paddle" },
    });
  }
}

export async function handOverOrgBeforeAccountDeletion(userId: string): Promise<void> {
  const mine = await prisma.orgMembership.findUnique({
    where: { userId },
    select: { orgId: true, role: true },
  });
  if (mine?.role === "OWNER") {
    try {
      const orphaned = await withOrgLock(mine.orgId, (tx) => handOver(tx, userId, mine.orgId));
      if (orphaned) await cancelOrphanedSubscription(mine.orgId, orphaned);
    } catch (err) {
      // Closed meanwhile: nothing left to hand over, and the deletion goes on.
      if (!(isOrgError(err) && err.code === "NOT_IN_ORG")) throw err;
    }
  }
  await prisma.orgAuditEvent.updateMany({
    where: { actorUserId: userId },
    data: { actorUserId: null },
  });
  await prisma.orgAuditEvent.updateMany({
    where: { targetUserId: userId },
    data: { targetUserId: null },
  });
  await prisma.orgInvite.updateMany({
    where: { invitedById: userId },
    data: { invitedById: null },
  });
  await prisma.orgInvite.updateMany({
    where: { acceptedById: userId },
    data: { acceptedById: null },
  });
}
