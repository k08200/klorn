/**
 * Seat entitlement, derived from organization membership at read time
 * (Klorn Teams launch feature 2). It is never written to User.plan, which the
 * three billing providers (Stripe, Paddle, RevenueCat) already write: a seat
 * comes and goes with the membership and the organization's subscription, so
 * leaving an organization or a lapsed team subscription needs no clean-up.
 *
 * effectiveTier is the single helper for "what tier does this user get": the
 * higher of their own plan and a TEAM seat. Premium seats ship later (after
 * the allocator with model step-down), so a seat is always a standard TEAM
 * seat here. While TEAMS_ENABLED is closed to the user it reads nothing.
 */

import { teamsOpenTo } from "../config.js";
import { prisma } from "../db.js";

export const TIERS = ["FREE", "PRO", "TEAM", "ENTERPRISE"] as const;
export type Tier = (typeof TIERS)[number];

const SEAT_BEARING_STATUSES = new Set(["active", "trialing"]);

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

/** True when the user's membership holds one of their organization's paid seats. */
export async function holdsTeamSeat(userId: string): Promise<boolean> {
  if (!teamsOpenTo(userId)) return false;
  const mine = await prisma.orgMembership.findUnique({
    where: { userId },
    select: {
      id: true,
      orgId: true,
      org: { select: { seatsPurchased: true, subscriptionStatus: true } },
    },
  });
  if (!mine || !seatsActive(mine.org.subscriptionStatus)) return false;
  const members = await prisma.orgMembership.findMany({
    where: { orgId: mine.orgId },
    select: { id: true, role: true, joinedAt: true },
  });
  return seatedMembershipIds(members, mine.org.seatsPurchased, mine.org.subscriptionStatus).has(
    mine.id,
  );
}

export async function effectiveTier(user: { id: string; plan: string }): Promise<Tier> {
  const own = normalizeTier(user.plan);
  if (own === "ENTERPRISE") return own;
  return (await holdsTeamSeat(user.id)) ? higherTier(own, "TEAM") : own;
}
