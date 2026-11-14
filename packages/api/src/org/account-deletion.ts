/**
 * What an account deletion does to the account's organization. A member's
 * membership and grant simply cascade away with the account. An OWNER hands
 * the organization to its longest-standing member (audited); an organization
 * left with no member is deleted, unless it still has a live team
 * subscription, which is reported instead of silently orphaned.
 *
 * Runs whatever TEAMS_ENABLED says: rows made while the flag was on must
 * still get an owner when that owner deletes their account.
 */

import { INTERACTIVE_TX_OPTIONS, prisma } from "../db.js";
import { captureError } from "../sentry.js";
import { recordOrgAudit } from "./audit.js";
import { seatsActive } from "./effective-tier.js";

export async function handOverOrgBeforeAccountDeletion(userId: string): Promise<void> {
  const mine = await prisma.orgMembership.findUnique({
    where: { userId },
    select: { orgId: true, role: true, org: { select: { subscriptionStatus: true } } },
  });
  if (!mine || mine.role !== "OWNER") return;
  const successor = await prisma.orgMembership.findFirst({
    where: { orgId: mine.orgId, userId: { not: userId } },
    orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
    select: { id: true, userId: true },
  });
  if (successor) {
    await prisma.$transaction(async (tx) => {
      await tx.orgMembership.update({
        where: { id: successor.id },
        data: { role: "OWNER" },
        select: { id: true },
      });
      await recordOrgAudit(tx, {
        orgId: mine.orgId,
        action: "owner.succeeded",
        actorUserId: null,
        targetUserId: successor.userId,
      });
    }, INTERACTIVE_TX_OPTIONS);
    return;
  }
  if (seatsActive(mine.org.subscriptionStatus)) {
    captureError(new Error("organization with a live team subscription lost its last member"), {
      tags: { scope: "org.account-deletion" },
      extra: { orgId: mine.orgId },
    });
    return;
  }
  await prisma.organization.delete({ where: { id: mine.orgId }, select: { id: true } });
}
