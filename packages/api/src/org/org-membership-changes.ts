/**
 * Membership changes (Klorn Teams v1): an owner removing a member, a member
 * leaving, and an ownership transfer. Each runs under the organization's row
 * lock (org-lock.ts) and decides on roles and counts read inside that lock,
 * so there is always exactly one OWNER while the organization has members.
 */

import { recordOrgAudit } from "./audit.js";
import { seatsActive } from "./effective-tier.js";
import { OrgError } from "./org-error.js";
import { membershipInTx, type OrgTx, ownerInTx, withOrgLock } from "./org-lock.js";
import { currentOrgView, requireMembership } from "./org-members.js";

const NOT_FOUND = () =>
  new OrgError(404, "MEMBER_NOT_FOUND", "No such member in your organization.");

async function targetInTx(tx: OrgTx, orgId: string, membershipId: unknown) {
  if (typeof membershipId !== "string" || membershipId.length === 0) return null;
  return tx.orgMembership.findFirst({
    where: { id: membershipId, orgId },
    select: { id: true, userId: true, role: true },
  });
}

export async function removeMember(userId: string, membershipId: string) {
  const { orgId } = await requireMembership(userId);
  await withOrgLock(orgId, async (tx) => {
    await ownerInTx(tx, userId, orgId);
    const target = await targetInTx(tx, orgId, membershipId);
    if (!target) throw NOT_FOUND();
    if (target.role === "OWNER") {
      throw new OrgError(
        409,
        "CANNOT_REMOVE_OWNER",
        "Transfer ownership before removing the owner.",
      );
    }
    await tx.orgMembership.delete({ where: { id: target.id }, select: { id: true } });
    await tx.availabilityGrant.deleteMany({ where: { userId: target.userId, orgId } });
    await recordOrgAudit(tx, {
      orgId,
      action: "member.removed",
      actorUserId: userId,
      targetUserId: target.userId,
    });
  });
  return { removed: true as const };
}

/** The last member, the owner, leaving closes the organization (invites, grants, audit cascade). */
async function closeOrganization(tx: OrgTx, orgId: string) {
  const members = await tx.orgMembership.count({ where: { orgId } });
  if (members > 1) {
    throw new OrgError(
      409,
      "OWNER_MUST_TRANSFER",
      "Transfer ownership to another member before you leave.",
    );
  }
  const org = await tx.organization.findUnique({
    where: { id: orgId },
    select: { subscriptionStatus: true },
  });
  if (seatsActive(org?.subscriptionStatus)) {
    throw new OrgError(
      409,
      "SUBSCRIPTION_ACTIVE",
      "Cancel the team subscription before you close the organization.",
    );
  }
  await tx.organization.delete({ where: { id: orgId }, select: { id: true } });
}

export async function leaveOrganization(userId: string) {
  const { orgId } = await requireMembership(userId);
  return withOrgLock(orgId, async (tx) => {
    const mine = await membershipInTx(tx, userId, orgId);
    if (mine.role === "OWNER") {
      await closeOrganization(tx, orgId);
      return { left: true as const, orgDeleted: true };
    }
    await tx.orgMembership.delete({ where: { id: mine.id }, select: { id: true } });
    await tx.availabilityGrant.deleteMany({ where: { userId, orgId } });
    await recordOrgAudit(tx, {
      orgId,
      action: "member.left",
      actorUserId: userId,
      targetUserId: userId,
    });
    return { left: true as const, orgDeleted: false };
  });
}

export async function transferOwnership(userId: string, body: unknown) {
  const membershipId = ((body ?? {}) as { membershipId?: unknown }).membershipId;
  const { orgId } = await requireMembership(userId);
  await withOrgLock(orgId, async (tx) => {
    const owner = await ownerInTx(tx, userId, orgId);
    const target = await targetInTx(tx, orgId, membershipId);
    if (!target || target.role !== "MEMBER") throw NOT_FOUND();
    // Demote first: the one-owner index never sees two OWNER rows.
    await tx.orgMembership.update({
      where: { id: owner.id },
      data: { role: "MEMBER" },
      select: { id: true },
    });
    await tx.orgMembership.update({
      where: { id: target.id },
      data: { role: "OWNER" },
      select: { id: true },
    });
    await recordOrgAudit(tx, {
      orgId,
      action: "owner.transferred",
      actorUserId: userId,
      targetUserId: target.userId,
    });
  });
  return currentOrgView(userId);
}
