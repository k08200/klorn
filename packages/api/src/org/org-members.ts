/**
 * Organization reads and settings (Klorn Teams v1): create, the current view,
 * settings and admin ceilings, the roster, the member's own free/busy grant
 * and the audit log. Membership changes (remove, leave, transfer) live in
 * org-membership-changes.ts, invites in org-invites.ts. Every admin action is
 * OWNER-only and audited in the same transaction as the change.
 *
 * Privacy: these functions read the org tables and, from another account,
 * its name and address only (org-privacy-guard.test.ts holds them to that).
 */

import { Prisma } from "@prisma/client";
import { INTERACTIVE_TX_OPTIONS, prisma } from "../db.js";
import { recordOrgAudit } from "./audit.js";
import { normalizeAgentModeCap } from "./ceilings.js";
import { seatedMembershipIds } from "./effective-tier.js";
import { OrgError } from "./org-error.js";
import { membershipInTx, ownerInTx, requireVerifiedEmail, withOrgLock } from "./org-lock.js";
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
const INVALID_NAME = "Give the organization a name (1–80 characters, not a link).";
const INVALID_DOMAINS = "Company domains must be up to 10 domain names.";

function isUniqueViolation(err: unknown, field: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return false;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? "")];
  return fields.some((name) => name.includes(field));
}

export function findMembership(userId: string): Promise<Membership | null> {
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

function createInput(body: unknown): { name: string; companyDomains: string[] } {
  const input = (body ?? {}) as { name?: unknown; companyDomains?: unknown };
  const name = normalizeOrgName(input.name);
  if (!name) throw new OrgError(400, "INVALID_NAME", INVALID_NAME);
  const companyDomains =
    input.companyDomains === undefined ? [] : normalizeDomains(input.companyDomains);
  if (!companyDomains) throw new OrgError(400, "INVALID_DOMAINS", INVALID_DOMAINS);
  return { name, companyDomains };
}

export async function createOrganization(userId: string, body: unknown) {
  const { name, companyDomains } = createInput(body);
  await requireVerifiedEmail(userId);
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

type Change = [Prisma.OrganizationUpdateInput, Record<string, Prisma.InputJsonValue | null>];

function nameChange(value: unknown): Change {
  const name = normalizeOrgName(value);
  if (!name) throw new OrgError(400, "INVALID_NAME", INVALID_NAME);
  return [{ name }, { name }];
}

function domainsChange(value: unknown): Change {
  const companyDomains = normalizeDomains(value);
  if (!companyDomains) throw new OrgError(400, "INVALID_DOMAINS", INVALID_DOMAINS);
  return [{ companyDomains }, { companyDomains }];
}

function autoReplyChange(value: unknown): Change {
  if (typeof value !== "boolean") {
    throw new OrgError(400, "INVALID_BODY", "autoReplyDisabled must be true or false.");
  }
  return [{ autoReplyDisabled: value }, { autoReplyDisabled: value }];
}

function capChange(value: unknown): Change {
  const agentModeCap = value === null ? null : normalizeAgentModeCap(value);
  if (value !== null && agentModeCap === null) {
    throw new OrgError(400, "INVALID_CAP", "agentModeCap must be OFF, SHADOW, SUGGEST or null.");
  }
  return [{ agentModeCap }, { agentModeCap }];
}

/** The settings an owner may change; every other key is ignored. */
const SETTINGS: Record<string, (value: unknown) => Change> = {
  name: nameChange,
  companyDomains: domainsChange,
  autoReplyDisabled: autoReplyChange,
  agentModeCap: capChange,
};

function settingsChange(body: unknown): Change {
  const input = (body ?? {}) as Record<string, unknown>;
  const changes = Object.entries(SETTINGS)
    .filter(([key]) => input[key] !== undefined)
    .map(([key, change]) => change(input[key]));
  if (changes.length === 0) throw new OrgError(400, "INVALID_BODY", "Nothing to change.");
  return [
    Object.assign({}, ...changes.map(([data]) => data)),
    Object.assign({}, ...changes.map(([, detail]) => detail)),
  ];
}

export async function updateOrganization(userId: string, body: unknown) {
  const [data, detail] = settingsChange(body);
  const owner = await requireOwner(userId);
  await withOrgLock(owner.orgId, async (tx) => {
    await ownerInTx(tx, userId, owner.orgId);
    await tx.organization.update({ where: { id: owner.orgId }, data, select: { id: true } });
    await recordOrgAudit(tx, {
      orgId: owner.orgId,
      action: "settings.changed",
      actorUserId: userId,
      detail,
    });
  });
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

export async function setAvailabilityGrant(userId: string, body: unknown) {
  const share = ((body ?? {}) as { shareFreeBusy?: unknown }).shareFreeBusy;
  if (typeof share !== "boolean") {
    throw new OrgError(400, "INVALID_BODY", "shareFreeBusy must be true or false.");
  }
  const mine = await requireMembership(userId);
  const scope = share ? "FREEBUSY" : "NONE";
  await withOrgLock(mine.orgId, async (tx) => {
    // Re-checked under the lock: a grant is never left behind for an
    // organization the member just left.
    await membershipInTx(tx, userId, mine.orgId);
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
  });
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

/** Names of the organization's current members, by user id (departed members are absent). */
async function memberLabels(orgId: string): Promise<Map<string, string>> {
  const members = await prisma.orgMembership.findMany({
    where: { orgId },
    select: { userId: true, user: { select: { name: true, email: true } } },
  });
  return new Map(members.map((m) => [m.userId, m.user.name || m.user.email]));
}

export interface AuditQuery {
  /** "admin" leaves out the free/busy reads, so they never bury an admin action. */
  kind?: unknown;
  /** The id of the last event of the previous page. */
  before?: unknown;
}

export async function listAudit(
  userId: string,
  query: AuditQuery,
): Promise<{ events: AuditWire[]; nextBefore: string | null }> {
  const owner = await requireOwner(userId);
  const before =
    typeof query.before === "string" && query.before.length <= 64 ? query.before : null;
  const [events, labels] = await Promise.all([
    prisma.orgAuditEvent.findMany({
      where: {
        orgId: owner.orgId,
        ...(query.kind === "admin" ? { action: { not: "availability.read" } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: AUDIT_PAGE,
      ...(before ? { cursor: { id: before }, skip: 1 } : {}),
      select: {
        id: true,
        action: true,
        actorUserId: true,
        targetUserId: true,
        detail: true,
        createdAt: true,
      },
    }),
    memberLabels(owner.orgId),
  ]);
  const name = (id: string | null) => (id ? (labels.get(id) ?? null) : null);
  return {
    events: events.map((event) => ({
      id: event.id,
      action: event.action,
      actor: name(event.actorUserId),
      target: name(event.targetUserId),
      detail: event.detail,
      createdAt: event.createdAt.toISOString(),
    })),
    nextBefore: events.length === AUDIT_PAGE ? (events.at(-1)?.id ?? null) : null,
  };
}

/** Who read this member's free/busy lately (the member's own transparency). */
export async function recentFreeBusyReads(userId: string, orgId: string, take = 20) {
  const [reads, labels] = await Promise.all([
    prisma.orgAuditEvent.findMany({
      where: { orgId, targetUserId: userId, action: "availability.read" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
      select: { actorUserId: true, detail: true, createdAt: true },
    }),
    memberLabels(orgId),
  ]);
  return reads.map((read) => ({
    by: read.actorUserId ? (labels.get(read.actorUserId) ?? null) : null,
    window: read.detail,
    at: read.createdAt.toISOString(),
  }));
}
