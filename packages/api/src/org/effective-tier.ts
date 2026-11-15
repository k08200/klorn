/**
 * Seat entitlement, derived from organization membership at read time
 * (Klorn Teams launch feature 2). It is never written to User.plan, which the
 * three billing providers (Stripe, Paddle, RevenueCat) already write: a seat
 * comes and goes with the membership and the organization's subscription, so
 * leaving an organization or a lapsed team subscription needs no clean-up.
 *
 * effectivePlan is the single resolver for "what plan does this user get": the
 * higher of their own plan and a TEAM seat. Every plan gate reads it (a static
 * guard, effective-tier-wiring-guard.test.ts, keeps it that way);
 * effectivePlans is its batch form for the schedulers and effectiveTier its
 * normalized form for /me and the entitlement preHandlers. Premium seats ship
 * later (after the allocator with model step-down), so a seat is always a
 * standard TEAM seat here. While TEAMS_ENABLED is closed to the user it reads
 * nothing and returns the own plan untouched.
 */

import { teamsOpenTo } from "../config.js";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";

export const TIERS = ["FREE", "PRO", "TEAM", "ENTERPRISE"] as const;
export type Tier = (typeof TIERS)[number];

/** The subscription statuses whose seats carry entitlement (and a pooled LLM budget). */
export const SEAT_BEARING_STATUS_LIST: readonly string[] = ["active", "trialing"];
const SEAT_BEARING_STATUSES = new Set(SEAT_BEARING_STATUS_LIST);

export function normalizeTier(value: unknown): Tier {
  return TIERS.includes(value as Tier) ? (value as Tier) : "FREE";
}

export function higherTier(a: Tier, b: Tier): Tier {
  return TIERS.indexOf(a) >= TIERS.indexOf(b) ? a : b;
}

export function seatsActive(status: string | null | undefined): boolean {
  return typeof status === "string" && SEAT_BEARING_STATUSES.has(status);
}

/**
 * True while a team subscription still bills or can recover (active,
 * trialing, past_due, paused): an organization in this state is never closed
 * or deleted, and gets no second checkout. Seats are a narrower question
 * (seatsActive).
 */
export function subscriptionBills(status: string | null | undefined): boolean {
  return typeof status === "string" && status !== "" && status !== "canceled";
}

interface SeatCandidate {
  id: string;
  role: "OWNER" | "MEMBER";
  joinedAt: Date;
}

/**
 * Which memberships hold the purchased seats: the owner first, then members by
 * join time (id breaks a tie, so the answer is stable). None while the
 * subscription is not active or trialing.
 */
export function seatedMembershipIds(
  members: readonly SeatCandidate[],
  seatsPurchased: number,
  status: string | null | undefined,
): Set<string> {
  if (!seatsActive(status) || seatsPurchased <= 0) return new Set();
  const ordered = [...members].sort(
    (a, b) =>
      Number(b.role === "OWNER") - Number(a.role === "OWNER") ||
      a.joinedAt.getTime() - b.joinedAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  return new Set(ordered.slice(0, seatsPurchased).map((member) => member.id));
}

/** The paid seat a user holds: their organization, its seat count, and who is seated. */
export interface TeamSeat {
  orgId: string;
  seatsPurchased: number;
  /** User ids holding the organization's purchased seats (this user included). */
  seatedUserIds: string[];
}

/**
 * The paid seat this user holds, or null. Null without a query while
 * TEAMS_ENABLED is closed to the user. seatedUserIds is for the pooled LLM
 * cost cap (billing/team-cost-pool.ts), which sums cost only; it never leaves
 * the server.
 */
export async function heldTeamSeat(userId: string): Promise<TeamSeat | null> {
  if (!teamsOpenTo(userId)) return null;
  const mine = await prisma.orgMembership.findUnique({
    where: { userId },
    select: {
      id: true,
      orgId: true,
      org: { select: { seatsPurchased: true, subscriptionStatus: true } },
    },
  });
  if (!mine || !seatsActive(mine.org.subscriptionStatus)) return null;
  const members = await prisma.orgMembership.findMany({
    where: { orgId: mine.orgId },
    select: { id: true, userId: true, role: true, joinedAt: true },
  });
  const seated = seatedMembershipIds(members, mine.org.seatsPurchased, mine.org.subscriptionStatus);
  if (!seated.has(mine.id)) return null;
  return {
    orgId: mine.orgId,
    seatsPurchased: mine.org.seatsPurchased,
    seatedUserIds: members.filter((m) => seated.has(m.id)).map((m) => m.userId),
  };
}

/** True when the user's membership holds one of their organization's paid seats. */
export async function holdsTeamSeat(userId: string): Promise<boolean> {
  return (await heldTeamSeat(userId)) !== null;
}

/** A seat never raises these: TEAM is what a seat grants, ENTERPRISE is above it. */
function seatCannotRaise(plan: string): boolean {
  const own = normalizeTier(plan);
  return own === "TEAM" || own === "ENTERPRISE";
}

/**
 * The plan value every gate helper reads (isEntitled, isHardPaywalled,
 * planHasFeature, getEffectivePlan, isToolAllowedForPlan, the MCP tool gate,
 * the linked-inbox sync scope): the user's own plan, raised to TEAM by a held
 * paid seat.
 *
 * Byte-identical while TEAMS_ENABLED is closed to the user: the own plan value
 * comes back untouched (not normalized) and nothing is queried, so every gate
 * answers exactly what it answered before seats existed. Personal Pro plus a
 * seat resolves to TEAM, the higher of the two (TIERS order).
 */
export async function effectivePlan(user: { id: string; plan: string }): Promise<string> {
  if (!teamsOpenTo(user.id) || seatCannotRaise(user.plan)) return user.plan;
  return (await holdsTeamSeat(user.id)) ? "TEAM" : user.plan;
}

interface MembershipWithOrg {
  id: string;
  userId: string;
  orgId: string;
  org: { seatsPurchased: number; subscriptionStatus: string | null };
}

/** Membership ids holding a seat, across the organizations of `mine`. One query. */
async function seatedAcross(mine: readonly MembershipWithOrg[]): Promise<Set<string>> {
  const orgs = new Map(mine.map((m) => [m.orgId, m.org]));
  const members = await prisma.orgMembership.findMany({
    where: { orgId: { in: [...orgs.keys()] } },
    select: { id: true, orgId: true, role: true, joinedAt: true },
  });
  const seated = new Set<string>();
  for (const [orgId, org] of orgs) {
    const roster = members.filter((m) => m.orgId === orgId);
    for (const id of seatedMembershipIds(roster, org.seatsPurchased, org.subscriptionStatus)) {
      seated.add(id);
    }
  }
  return seated;
}

/**
 * effectivePlan for many users (schedulers, pattern learning): user id → plan.
 * No query while TEAMS_ENABLED is closed to every user; otherwise two queries
 * however many users there are (their memberships, then the rosters of the
 * organizations still billing seats).
 */
export async function effectivePlans(
  users: readonly { id: string; plan: string }[],
): Promise<Map<string, string>> {
  const plans = new Map(users.map((user) => [user.id, user.plan]));
  const candidates = users.filter((u) => teamsOpenTo(u.id) && !seatCannotRaise(u.plan));
  if (candidates.length === 0) return plans;
  const memberships = await prisma.orgMembership.findMany({
    where: { userId: { in: candidates.map((u) => u.id) } },
    select: {
      id: true,
      userId: true,
      orgId: true,
      org: { select: { seatsPurchased: true, subscriptionStatus: true } },
    },
  });
  const live = memberships.filter((m) => seatsActive(m.org.subscriptionStatus));
  if (live.length === 0) return plans;
  const seated = await seatedAcross(live);
  for (const membership of live) {
    if (seated.has(membership.id)) plans.set(membership.userId, "TEAM");
  }
  return plans;
}

export async function effectiveTier(user: { id: string; plan: string }): Promise<Tier> {
  return normalizeTier(await effectivePlan(user));
}

function reportSeatLookup(err: unknown, scope: string, extra: Record<string, unknown>): void {
  console.warn(`[effective-tier] seat lookup failed (${scope}) — using the own plan:`, err);
  captureError(err, { tags: { scope: `effective-tier.${scope}` }, extra });
}

/**
 * effectivePlan for a path that is not an access gate (a device limit, a
 * displayed plan): a failed seat lookup is reported and falls back to the own
 * plan — never a higher one — instead of failing the request. Access gates
 * keep effectivePlan, which throws (fail closed).
 */
export async function effectivePlanOrOwn(user: { id: string; plan: string }): Promise<string> {
  try {
    return await effectivePlan(user);
  } catch (err) {
    reportSeatLookup(err, "single", { userId: user.id });
    return user.plan;
  }
}

/**
 * effectivePlans for the schedulers: a failed seat lookup is reported and
 * every user keeps their own plan (never a higher one), so an org-table fault
 * cannot stop briefing, sync and classify for everyone.
 */
export async function effectivePlansOrOwn(
  users: readonly { id: string; plan: string }[],
): Promise<Map<string, string>> {
  try {
    return await effectivePlans(users);
  } catch (err) {
    reportSeatLookup(err, "batch", { users: users.length });
    return new Map(users.map((user) => [user.id, user.plan]));
  }
}

/** The personal subscription fields Klorn stores (written by the Paddle webhook only). */
interface PersonalBilling {
  paddleSubscriptionId: string | null;
  subscriptionStatus: string | null;
  subscriptionCancelAt: Date | null;
}

/**
 * True when a held team seat already covers the user's own paid Pro and that
 * personal Paddle subscription is live and still set to renew: the user pays
 * twice. (ownPlan PRO resolving to TEAM can only mean a held seat.) Only the
 * Paddle path stores renewal state, so a comped Pro, a Stripe customer or an
 * App Store / Play subscriber is never told "still renews" on a guess.
 *
 * Klorn never cancels the personal plan itself — a default chosen on the
 * founder's behalf on 2026-11-14, pending founder confirmation and reversible
 * (pricing-tiers.md, "Personal Pro and a team seat"): a cancel is a money
 * action, and the seat can lapse with the organization's subscription or a
 * removal. /me and /api/billing/status carry this so the app can say so next
 * to the personal cancel.
 */
export function seatCoversPersonalPlan(
  ownPlan: string,
  effective: string,
  personal: PersonalBilling,
): boolean {
  return (
    ownPlan === "PRO" &&
    effective === "TEAM" &&
    personal.paddleSubscriptionId !== null &&
    seatsActive(personal.subscriptionStatus) &&
    personal.subscriptionCancelAt === null
  );
}
