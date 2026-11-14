/**
 * Organization lifecycle (Klorn Teams v1): create, read, settings and admin
 * ceilings, the member roster, removal, leaving, ownership transfer, the
 * member's own free/busy grant and the audit log. Every admin action is
 * OWNER-only and audited in the same transaction as the change.
 *
 * Privacy: these functions read the org tables and, from another account,
 * its name and address only (org-privacy-guard.test.ts holds them to that).
 */

import { Prisma } from "@prisma/client";
import { INTERACTIVE_TX_OPTIONS, prisma } from "../db.js";
import { recordOrgAudit } from "./audit.js";
import { normalizeAgentModeCap } from "./ceilings.js";
import { seatedMembershipIds, seatsActive } from "./effective-tier.js";
import { OrgError } from "./org-error.js";
import {
  normalizeDomains,
  normalizeOrgName,
  ORG_SELECT,
  type OrgRow,
  type OrgWire,
  orgWire,
  slugFor,
} from "./org-shape.js";

export interface MeWire {
  membershipId: string;
  role: "OWNER" | "MEMBER";
  seated: boolean;
  sharesFreeBusy: boolean;
}

export interface MemberWire {
  membershipId: string;
  name: string | null;
  email: string;
  role: "OWNER" | "MEMBER";
  joinedAt: string;
  seated: boolean;
  sharesFreeBusy: boolean;
  isYou: boolean;
}

export interface Membership {
  id: string;
  orgId: string;
  role: "OWNER" | "MEMBER";
  joinedAt: Date;
  org: OrgRow;
}

const SLUG_ATTEMPTS = 3;
const AUDIT_PAGE = 100;

function isUniqueViolation(err: unknown, field: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return false;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? "")];
  return fields.some((name) => name.includes(field));
}

export async function findMembership(userId: string): Promise<Membership | null> {
  return prisma.orgMembership.findUnique({
    where: { userId },
    select: { id: true, orgId: true, role: true, joinedAt: true, org: { select: ORG_SELECT } },
  });
}

export async function requireMembership(userId: string): Promise<Membership> {
  const membership = await findMembership(userId);
  if (!membership) throw new OrgError(404, "NOT_IN_ORG", "You are not in an organization.");
  return membership;
}

export async function requireOwner(userId: string): Promise<Membership> {
  const membership = await requireMembership(userId);
  if (membership.role !== "OWNER") {
    throw new OrgError(403, "OWNER_ONLY", "Only the organization's owner can do this.");
  }
  return membership;
}

export async function currentOrgView(
  userId: string,
): Promise<{ org: null } | { org: OrgWire; me: MeWire }> {
  const mine = await findMembership(userId);
  if (!mine) return { org: null };
  const [members, grant] = await Promise.all([
    prisma.orgMembership.findMany({
      where: { orgId: mine.orgId },
      select: { id: true, role: true, joinedAt: true },
    }),
    prisma.availabilityGrant.findUnique({
      where: { userId },
      select: { orgId: true, scope: true },
    }),
  ]);
  const seated = seatedMembershipIds(members, mine.org.seatsPurchased, mine.org.subscriptionStatus);
  return {
    org: orgWire(mine.org, members.length, normalizeAgentModeCap(mine.org.agentModeCap)),
    me: {
      membershipId: mine.id,
      role: mine.role,
      seated: seated.has(mine.id),
      sharesFreeBusy: grant?.orgId === mine.orgId && grant.scope === "FREEBUSY",
    },
  };
}

export async function createOrganization(userId: string, body: unknown) {
  const input = (body ?? {}) as { name?: unknown; companyDomains?: unknown };
  const name = normalizeOrgName(input.name);
  if (!name)
    throw new OrgError(400, "INVALID_NAME", "Give the organization a name (1–80 characters).");
  const companyDomains =
    input.companyDomains === undefined ? [] : normalizeDomains(input.companyDomains);
  if (!companyDomains) {
    throw new OrgError(400, "INVALID_DOMAINS", "Company domains must be up to 10 domain names.");
  }
  if (await findMembership(userId)) {
    throw new OrgError(409, "ALREADY_IN_ORG", "You are already in an organization.");
  }
  for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt++) {
    try {
      await prisma.$transaction(async (tx) => {
        const org = await tx.organization.create({
          data: {
            name,
            slug: slugFor(name),
            companyDomains,
            memberships: { create: { userId, role: "OWNER" } },
            availabilityGrants: { create: { userId, scope: "NONE" } },
          },
          select: { id: true },
        });
        await recordOrgAudit(tx, { orgId: org.id, action: "org.created", actorUserId: userId });
      }, INTERACTIVE_TX_OPTIONS);
      return currentOrgView(userId);
    } catch (err) {
      if (isUniqueViolation(err, "userId")) {
        throw new OrgError(409, "ALREADY_IN_ORG", "You are already in an organization.");
      }
      if (!isUniqueViolation(err, "slug") || attempt === SLUG_ATTEMPTS) throw err;
    }
  }
  throw new Error("unreachable: slug attempts exhausted");
}

interface SettingsChange {
  data: Prisma.OrganizationUpdateInput;
  detail: Record<string, Prisma.InputJsonValue | null>;
}

function settingsChange(body: unknown): SettingsChange {
  const input = (body ?? {}) as Record<string, unknown>;
  const data: Prisma.OrganizationUpdateInput = {};
  const detail: Record<string, Prisma.InputJsonValue | null> = {};
  if (input.name !== undefined) {
    const name = normalizeOrgName(input.name);
    if (!name)
      throw new OrgError(400, "INVALID_NAME", "Give the organization a name (1–80 characters).");
    data.name = name;
    detail.name = name;
  }
  if (input.companyDomains !== undefined) {
    const domains = normalizeDomains(input.companyDomains);
    if (!domains) {
      throw new OrgError(400, "INVALID_DOMAINS", "Company domains must be up to 10 domain names.");
    }
    data.companyDomains = domains;
    detail.companyDomains = domains;
  }
  if (input.autoReplyDisabled !== undefined) {
    if (typeof input.autoReplyDisabled !== "boolean") {
      throw new OrgError(400, "INVALID_BODY", "autoReplyDisabled must be true or false.");
    }
    data.autoReplyDisabled = input.autoReplyDisabled;
    detail.autoReplyDisabled = input.autoReplyDisabled;
  }
  if (input.agentModeCap !== undefined) {
    const cap = input.agentModeCap === null ? null : normalizeAgentModeCap(input.agentModeCap);
    if (input.agentModeCap !== null && cap === null) {
      throw new OrgError(400, "INVALID_CAP", "agentModeCap must be OFF, SHADOW, SUGGEST or null.");
    }
    data.agentModeCap = cap;
    detail.agentModeCap = cap;
  }
  if (Object.keys(data).length === 0) {
    throw new OrgError(400, "INVALID_BODY", "Nothing to change.");
  }
  return { data, detail };
}

export async function updateOrganization(userId: string, body: unknown) {
  const owner = await requireOwner(userId);
  const { data, detail } = settingsChange(body);
  await prisma.$transaction(async (tx) => {
    await tx.organization.update({ where: { id: owner.orgId }, data, select: { id: true } });
    await recordOrgAudit(tx, {
      orgId: owner.orgId,
      action: "settings.changed",
      actorUserId: userId,
      detail,
    });
  }, INTERACTIVE_TX_OPTIONS);
  return currentOrgView(userId);
}

export async function listMembers(userId: string): Promise<MemberWire[]> {
  const mine = await requireMembership(userId);
  const [members, grants] = await Promise.all([
    prisma.orgMembership.findMany({
      where: { orgId: mine.orgId },
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        role: true,
        joinedAt: true,
        userId: true,
        user: { select: { name: true, email: true } },
      },
    }),
    prisma.availabilityGrant.findMany({
      where: { orgId: mine.orgId, scope: "FREEBUSY" },
      select: { userId: true },
    }),
  ]);
  const sharing = new Set(grants.map((grant) => grant.userId));
  const seated = seatedMembershipIds(members, mine.org.seatsPurchased, mine.org.subscriptionStatus);
  return members.map((member) => ({
    membershipId: member.id,
    name: member.user.name,
    email: member.user.email,
    role: member.role,
    joinedAt: member.joinedAt.toISOString(),
    seated: seated.has(member.id),
    sharesFreeBusy: sharing.has(member.userId),
    isYou: member.userId === userId,
  }));
}

async function memberOf(orgId: string, membershipId: unknown) {
  if (typeof membershipId !== "string" || membershipId.length === 0) return null;
  return prisma.orgMembership.findFirst({
    where: { id: membershipId, orgId },
    select: { id: true, userId: true, role: true },
  });
}

export async function removeMember(userId: string, membershipId: string) {
  const owner = await requireOwner(userId);
  const target = await memberOf(owner.orgId, membershipId);
  if (!target) throw new OrgError(404, "MEMBER_NOT_FOUND", "No such member in your organization.");
  if (target.role === "OWNER") {
    throw new OrgError(409, "CANNOT_REMOVE_OWNER", "Transfer ownership before removing the owner.");
  }
  await prisma.$transaction(async (tx) => {
    await tx.orgMembership.deleteMany({ where: { id: target.id, orgId: owner.orgId } });
    await tx.availabilityGrant.deleteMany({ where: { userId: target.userId, orgId: owner.orgId } });
    await recordOrgAudit(tx, {
      orgId: owner.orgId,
      action: "member.removed",
      actorUserId: userId,
      targetUserId: target.userId,
    });
  }, INTERACTIVE_TX_OPTIONS);
  return { removed: true as const };
}

export async function leaveOrganization(userId: string) {
  const mine = await requireMembership(userId);
  if (mine.role === "OWNER") {
    const members = await prisma.orgMembership.count({ where: { orgId: mine.orgId } });
    if (members > 1) {
      throw new OrgError(
        409,
        "OWNER_MUST_TRANSFER",
        "Transfer ownership to another member before you leave.",
      );
    }
    if (seatsActive(mine.org.subscriptionStatus)) {
      throw new OrgError(
        409,
        "SUBSCRIPTION_ACTIVE",
        "Cancel the team subscription before you close the organization.",
      );
    }
    // The last member leaving closes the organization: its invites, grants and
    // audit rows go with it (foreign keys cascade).
    await prisma.organization.delete({ where: { id: mine.orgId }, select: { id: true } });
    return { left: true as const, orgDeleted: true };
  }
  await prisma.$transaction(async (tx) => {
    await tx.orgMembership.deleteMany({ where: { id: mine.id } });
    await tx.availabilityGrant.deleteMany({ where: { userId, orgId: mine.orgId } });
    await recordOrgAudit(tx, {
      orgId: mine.orgId,
      action: "member.left",
      actorUserId: userId,
      targetUserId: userId,
    });
  }, INTERACTIVE_TX_OPTIONS);
  return { left: true as const, orgDeleted: false };
}

export async function transferOwnership(userId: string, body: unknown) {
  const owner = await requireOwner(userId);
  const membershipId = ((body ?? {}) as { membershipId?: unknown }).membershipId;
  const target = await memberOf(owner.orgId, membershipId);
  if (!target || target.role !== "MEMBER") {
    throw new OrgError(404, "MEMBER_NOT_FOUND", "No such member in your organization.");
  }
  await prisma.$transaction(async (tx) => {
    // Conditional updates keep exactly one OWNER even when two transfers race.
    const demoted = await tx.orgMembership.updateMany({
      where: { id: owner.id, role: "OWNER" },
      data: { role: "MEMBER" },
    });
    if (demoted.count !== 1) {
      throw new OrgError(403, "OWNER_ONLY", "Only the organization's owner can do this.");
    }
    const promoted = await tx.orgMembership.updateMany({
      where: { id: target.id, orgId: owner.orgId, role: "MEMBER" },
      data: { role: "OWNER" },
    });
    if (promoted.count !== 1) {
      throw new OrgError(404, "MEMBER_NOT_FOUND", "No such member in your organization.");
    }
    await recordOrgAudit(tx, {
      orgId: owner.orgId,
      action: "owner.transferred",
      actorUserId: userId,
      targetUserId: target.userId,
    });
  }, INTERACTIVE_TX_OPTIONS);
  return currentOrgView(userId);
}

export async function setAvailabilityGrant(userId: string, body: unknown) {
  const share = ((body ?? {}) as { shareFreeBusy?: unknown }).shareFreeBusy;
  if (typeof share !== "boolean") {
    throw new OrgError(400, "INVALID_BODY", "shareFreeBusy must be true or false.");
  }
  const mine = await requireMembership(userId);
  const scope = share ? "FREEBUSY" : "NONE";
  await prisma.$transaction(async (tx) => {
    await tx.availabilityGrant.upsert({
      where: { userId },
      create: { userId, orgId: mine.orgId, scope },
      update: { orgId: mine.orgId, scope },
      select: { userId: true },
    });
    await recordOrgAudit(tx, {
      orgId: mine.orgId,
      action: "availability.grant_changed",
      actorUserId: userId,
      targetUserId: userId,
      detail: { shared: share },
    });
  }, INTERACTIVE_TX_OPTIONS);
  return { sharesFreeBusy: share };
}

export interface AuditWire {
  id: string;
  action: string;
  actor: string | null;
  target: string | null;
  detail: Prisma.JsonValue;
  createdAt: string;
}

export async function listAudit(userId: string): Promise<AuditWire[]> {
  const owner = await requireOwner(userId);
  const [events, members] = await Promise.all([
    prisma.orgAuditEvent.findMany({
      where: { orgId: owner.orgId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: AUDIT_PAGE,
      select: {
        id: true,
        action: true,
        actorUserId: true,
        targetUserId: true,
        detail: true,
        createdAt: true,
      },
    }),
    prisma.orgMembership.findMany({
      where: { orgId: owner.orgId },
      select: { userId: true, user: { select: { name: true, email: true } } },
    }),
  ]);
  // People are named only while they are members; a departed one shows as null.
  const label = new Map(members.map((m) => [m.userId, m.user.name || m.user.email]));
  const name = (id: string | null) => (id ? (label.get(id) ?? null) : null);
  return events.map((event) => ({
    id: event.id,
    action: event.action,
    actor: name(event.actorUserId),
    target: name(event.targetUserId),
    detail: event.detail,
    createdAt: event.createdAt.toISOString(),
  }));
}
