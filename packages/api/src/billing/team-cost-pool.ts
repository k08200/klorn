/**
 * The pooled Klorn Teams LLM budget (pricing-tiers.md: $0.80 / seat / day,
 * pooled across the team; "one person can use more on a day the others use
 * less").
 *
 * A seat holder may spend what the pool has left: seatsPurchased x
 * TEAM_SEAT_DAILY_COST_CAP_CENTS minus today's spend by the organization's
 * other seated members, where each of them counts as at least a protected
 * floor (half the seat target). The floor keeps one member — a chat-heavy
 * day, a runaway loop, a leaked key — from draining the pool down to the
 * others' own-plan caps, which would push a paying seat's judge to keyword
 * fallback. It also hides small per-member spend from the pool arithmetic.
 * Each member is further bounded by the pricing doc's 10x anomaly brake.
 * cost-guard.ts never lets the result fall below the member's own plan cap.
 *
 * The pool counts purchased seats, not filled ones: unfilled paid seats feed
 * the filled members (bounded by the brake). Only currently seated members'
 * spend is summed, so a member removed mid-day drops out of the sum.
 *
 * Privacy: this reads only the cost ledger's integer cents for seated
 * members' ids — no mail, attention items, commitments or calendar — and the
 * figure is used for the gate decision only, never returned to anyone. It
 * lives in billing/, not org/, because org code may touch only the org tables
 * (org-privacy-guard.test.ts).
 */

import { TEAM_SEAT_DAILY_COST_CAP_CENTS } from "../config.js";
import { prisma } from "../db.js";
import { heldTeamSeat } from "../org/effective-tier.js";

/** pricing-tiers.md "anomaly brake": 10x the target stops a runaway loop. */
export const TEAM_MEMBER_BRAKE_MULTIPLIER = 10;

/** Share of the seat target each other seated member keeps out of my reach. */
export const TEAM_MEMBER_FLOOR_SHARE = 0.5;

/**
 * The pool is re-read at most this often per user and day. resolveCapCents
 * runs twice per LLM call (check, then record), and a cache miss costs three
 * queries (membership, roster, ledger). Staleness is bounded: other members'
 * spend in the last 30 s, and a lapsed or removed seat keeps its pool for 30 s.
 */
const POOL_TTL_MS = 30_000;
/** A failed lookup is retried after 5 s, not on every call (no report flood). */
const FAILURE_TTL_MS = 5_000;
const POOL_CACHE_MAX = 5_000;

interface CachedPool {
  dayKey: string;
  expiresAt: number;
  capCents: number | null;
}

const poolCache = new Map<string, CachedPool>();

function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function othersCountedSpend(others: string[], dayKey: string): Promise<number> {
  if (others.length === 0) return 0;
  const rows = await prisma.llmCostLedger.groupBy({
    by: ["userId"],
    where: { userId: { in: others }, dayKey },
    _sum: { cents: true },
  });
  const spent = new Map(rows.map((row) => [row.userId, row._sum.cents ?? 0]));
  const floor = Math.floor(TEAM_SEAT_DAILY_COST_CAP_CENTS * TEAM_MEMBER_FLOOR_SHARE);
  return others.reduce((sum, id) => sum + Math.max(spent.get(id) ?? 0, floor), 0);
}

async function computePoolCapCents(userId: string, dayKey: string): Promise<number | null> {
  const seat = await heldTeamSeat(userId);
  if (!seat) return null;
  const pool = seat.seatsPurchased * TEAM_SEAT_DAILY_COST_CAP_CENTS;
  const others = seat.seatedUserIds.filter((id) => id !== userId);
  const counted = await othersCountedSpend(others, dayKey);
  const brake = TEAM_SEAT_DAILY_COST_CAP_CENTS * TEAM_MEMBER_BRAKE_MULTIPLIER;
  return Math.min(Math.max(0, pool - counted), brake);
}

function remember(userId: string, entry: CachedPool): void {
  poolCache.delete(userId);
  if (poolCache.size >= POOL_CACHE_MAX) {
    const oldest = poolCache.keys().next().value;
    if (oldest !== undefined) poolCache.delete(oldest);
  }
  poolCache.set(userId, entry);
}

/**
 * Today's pooled cap for a seat holder in cents, or null when the user holds
 * no paid seat (always null, with no query, while TEAMS_ENABLED is closed to
 * them). A database failure throws once — the caller reports it and falls
 * back — and then reads as "no pool" for FAILURE_TTL_MS.
 */
export async function teamPoolCapCents(userId: string, now = new Date()): Promise<number | null> {
  const dayKey = utcDayKey(now);
  const cached = poolCache.get(userId);
  if (cached && cached.dayKey === dayKey && now.getTime() < cached.expiresAt) {
    return cached.capCents;
  }
  try {
    const capCents = await computePoolCapCents(userId, dayKey);
    remember(userId, { dayKey, expiresAt: now.getTime() + POOL_TTL_MS, capCents });
    return capCents;
  } catch (err) {
    remember(userId, { dayKey, expiresAt: now.getTime() + FAILURE_TTL_MS, capCents: null });
    throw err;
  }
}

/** Test seam: forget every cached pool. */
export function __resetTeamPoolCacheForTest(): void {
  poolCache.clear();
}
