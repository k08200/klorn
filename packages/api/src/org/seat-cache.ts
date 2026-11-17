/**
 * The Klorn Teams seat lookups that run on every LLM call — BYOK on a seat
 * (llm/llm-credentials.ts) and the pooled cost cap (billing/team-cost-pool.ts)
 * — trusted for SEAT_CACHE_TTL_MS. Every other plan gate reads uncached
 * (effective-tier.ts), so an owner's change shows there at once; a static
 * guard (effective-tier-wiring-guard.test.ts) keeps these two the only users.
 *
 * One organization's roster is read once per window for all of its members:
 * the read names every member's organization, so it primes their entries too,
 * and concurrent misses share one read in flight. A 150-seat team costs a
 * membership and a roster read per window, not one of each per member.
 * Staleness is bounded by the window: a removed member, a lapsed subscription
 * or a seat change reaches these two paths within 30 s (the pool's window
 * since it shipped). A failed read throws once and then reads as "no seat"
 * for 5 s (the own plan applies; never a higher one). While TEAMS_ENABLED is
 * closed to the user nothing is read or cached.
 */

import { teamsOpenTo } from "../config.js";
import { prisma } from "../db.js";
import { createSharedRead } from "../shared-read.js";
import {
  seatCannotRaise,
  seatedMembershipIds,
  seatsActive,
  type TeamSeat,
} from "./effective-tier.js";

export const SEAT_CACHE_TTL_MS = 30_000;
/** A failed read is retried after 5 s, not on every call (no report flood). */
const SEAT_FAILURE_TTL_MS = 5_000;
export const SEAT_CACHE_MAX_USERS = 5_000;
const SEAT_CACHE_MAX_ORGS = 1_000;

interface CachedSeats {
  seatsPurchased: number;
  seatedUserIds: readonly string[];
  seated: ReadonlySet<string>;
}

/** An organization's seats as read: null without a seat-bearing subscription, or after a failed read. */
interface CachedOrg {
  expiresAt: number;
  seats: CachedSeats | null;
}

/** A user's organization as read: null without a membership, or after a failed read. */
interface CachedMembership {
  expiresAt: number;
  orgId: string | null;
}

interface OrgSeatsRead {
  orgId: string;
  seats: CachedSeats | null;
}

interface OrgBilling {
  seatsPurchased: number;
  subscriptionStatus: string | null;
}

const orgSeatCache = new Map<string, CachedOrg>();
const membershipCache = new Map<string, CachedMembership>();
const sharedMembershipRead = createSharedRead<OrgSeatsRead | null>();
const sharedRosterRead = createSharedRead<CachedSeats | null>();

/** Insert as the newest entry, dropping the oldest once the cache is full. */
function remember<V>(cache: Map<string, V>, max: number, key: string, value: V): void {
  cache.delete(key);
  if (cache.size >= max) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

function fresh<E extends { expiresAt: number }>(entry: E | undefined, now: number): E | null {
  return entry !== undefined && now < entry.expiresAt ? entry : null;
}

function rememberOrg(orgId: string, expiresAt: number, seats: CachedSeats | null): void {
  remember(orgSeatCache, SEAT_CACHE_MAX_ORGS, orgId, { expiresAt, seats });
}

function rememberMembership(userId: string, expiresAt: number, orgId: string | null): void {
  remember(membershipCache, SEAT_CACHE_MAX_USERS, userId, { expiresAt, orgId });
}

/** The roster of an organization billing seats; primes every member's entry. */
async function readRoster(
  orgId: string,
  org: OrgBilling,
  now: number,
): Promise<CachedSeats | null> {
  if (!seatsActive(org.subscriptionStatus) || org.seatsPurchased <= 0) {
    rememberOrg(orgId, now + SEAT_CACHE_TTL_MS, null);
    return null;
  }
  const roster = await prisma.orgMembership
    .findMany({
      where: { orgId },
      select: { id: true, userId: true, role: true, joinedAt: true },
    })
    .catch((err: unknown) => {
      rememberOrg(orgId, now + SEAT_FAILURE_TTL_MS, null);
      throw err;
    });
  const seatedIds = seatedMembershipIds(roster, org.seatsPurchased, org.subscriptionStatus);
  const seatedUserIds = Object.freeze(
    roster.filter((m) => seatedIds.has(m.id)).map((m) => m.userId),
  );
  const seats: CachedSeats = Object.freeze({
    seatsPurchased: org.seatsPurchased,
    seatedUserIds,
    seated: new Set(seatedUserIds),
  });
  const expiresAt = now + SEAT_CACHE_TTL_MS;
  rememberOrg(orgId, expiresAt, seats);
  for (const member of roster) rememberMembership(member.userId, expiresAt, orgId);
  return seats;
}

/** Read the user's membership, then (unless cached or in flight) their organization's roster. */
async function readOrgSeats(userId: string, now: number): Promise<OrgSeatsRead | null> {
  const mine = await prisma.orgMembership
    .findUnique({
      where: { userId },
      select: { orgId: true, org: { select: { seatsPurchased: true, subscriptionStatus: true } } },
    })
    .catch((err: unknown) => {
      rememberMembership(userId, now + SEAT_FAILURE_TTL_MS, null);
      throw err;
    });
  rememberMembership(userId, now + SEAT_CACHE_TTL_MS, mine?.orgId ?? null);
  if (!mine) return null;
  const known = fresh(orgSeatCache.get(mine.orgId), now);
  if (known) return { orgId: mine.orgId, seats: known.seats };
  const seats = await sharedRosterRead(mine.orgId, () => readRoster(mine.orgId, mine.org, now));
  return { orgId: mine.orgId, seats };
}

async function orgSeatsFor(userId: string, now: number): Promise<OrgSeatsRead | null> {
  const known = fresh(membershipCache.get(userId), now);
  if (known) {
    if (known.orgId === null) return null;
    const org = fresh(orgSeatCache.get(known.orgId), now);
    if (org) return { orgId: known.orgId, seats: org.seats };
  }
  return sharedMembershipRead(userId, () => readOrgSeats(userId, now));
}

/**
 * heldTeamSeat (effective-tier.ts) for the per-LLM-call paths: the same seat,
 * trusted for SEAT_CACHE_TTL_MS. Null without a query while TEAMS_ENABLED is
 * closed to the user. A failed read throws (the caller reports it and falls
 * back to the own plan), then reads as "no seat" for 5 s — for every member
 * of the organization when its roster read failed.
 */
export async function cachedHeldTeamSeat(
  userId: string,
  now = Date.now(),
): Promise<TeamSeat | null> {
  if (!teamsOpenTo(userId)) return null;
  const read = await orgSeatsFor(userId, now);
  const seats = read?.seats ?? null;
  if (read === null || seats === null || !seats.seated.has(userId)) return null;
  return {
    orgId: read.orgId,
    seatsPurchased: seats.seatsPurchased,
    seatedUserIds: seats.seatedUserIds,
  };
}

/**
 * effectivePlan (effective-tier.ts) for the per-LLM-call paths (BYOK on a
 * seat): the same answer, trusted for SEAT_CACHE_TTL_MS. Byte-identical while
 * TEAMS_ENABLED is closed to the user: the own plan untouched, nothing read.
 */
export async function effectivePlanCached(
  user: { id: string; plan: string },
  now = Date.now(),
): Promise<string> {
  if (!teamsOpenTo(user.id) || seatCannotRaise(user.plan)) return user.plan;
  return (await cachedHeldTeamSeat(user.id, now)) ? "TEAM" : user.plan;
}

/** Test seam: forget every cached seat. */
export function __resetSeatCacheForTest(): void {
  orgSeatCache.clear();
  membershipCache.clear();
}

/** Test seam: how many users and organizations the seat cache holds. */
export function __seatCacheSizeForTest(): { users: number; orgs: number } {
  return { users: membershipCache.size, orgs: orgSeatCache.size };
}
