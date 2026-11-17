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
import type { TeamSeat } from "../org/effective-tier.js";
import {
  __resetSeatCacheForTest,
  cachedHeldTeamSeat,
  SEAT_CACHE_TTL_MS,
} from "../org/seat-cache.js";
import { createSharedRead } from "../shared-read.js";

/** pricing-tiers.md "anomaly brake": 10x the target stops a runaway loop. */
export const TEAM_MEMBER_BRAKE_MULTIPLIER = 10;

/** Share of the seat target each other seated member keeps out of my reach. */
export const TEAM_MEMBER_FLOOR_SHARE = 0.5;

/**
 * Today's spend is read at most this often per organization, the seat
 * lookup's window (org/seat-cache.ts, which reads one roster per
 * organization). resolveCapCents runs twice per LLM call; one ledger read per
 * organization and window serves every member (concurrent misses share it),
 * where a read per member cost a 150-seat team 150. Staleness is bounded:
 * other members' spend in the last 30 s, and a lapsed or removed seat keeps
 * its pool for 30 s.
 */
const SPEND_TTL_MS = SEAT_CACHE_TTL_MS;
/** A failed read is retried after 5 s, not on every call (no report flood). */
const FAILURE_TTL_MS = 5_000;
const SPEND_CACHE_MAX = 1_000;

/** One organization's seated members' spend today: null after a failed read. */
interface CachedSpend {
  dayKey: string;
  expiresAt: number;
  spent: ReadonlyMap<string, number> | null;
}

const spendCache = new Map<string, CachedSpend>();
const sharedSpendRead = createSharedRead<ReadonlyMap<string, number>>();

function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function remember(orgId: string, entry: CachedSpend): void {
  spendCache.delete(orgId);
  if (spendCache.size >= SPEND_CACHE_MAX) {
    const oldest = spendCache.keys().next().value;
    if (oldest !== undefined) spendCache.delete(oldest);
  }
  spendCache.set(orgId, entry);
}

/**
 * Today's ledger cents per seated member of the seat's organization. A member
 * seated after the read counts at the floor until the next one.
 */
async function seatedSpendToday(
  seat: TeamSeat,
  dayKey: string,
  now: number,
): Promise<ReadonlyMap<string, number> | null> {
  const cached = spendCache.get(seat.orgId);
  if (cached && cached.dayKey === dayKey && now < cached.expiresAt) return cached.spent;
  return sharedSpendRead(`${seat.orgId}:${dayKey}`, () => readSeatedSpend(seat, dayKey, now));
}

async function readSeatedSpend(
  seat: TeamSeat,
  dayKey: string,
  now: number,
): Promise<ReadonlyMap<string, number>> {
  const rows = await prisma.llmCostLedger
    .groupBy({
      by: ["userId"],
      where: { userId: { in: [...seat.seatedUserIds] }, dayKey },
      _sum: { cents: true },
    })
    .catch((err: unknown) => {
      remember(seat.orgId, { dayKey, expiresAt: now + FAILURE_TTL_MS, spent: null });
      throw err;
    });
  const spent: ReadonlyMap<string, number> = new Map(
    rows.map((row) => [row.userId, row._sum.cents ?? 0]),
  );
  remember(seat.orgId, { dayKey, expiresAt: now + SPEND_TTL_MS, spent });
  return spent;
}

/** What the pool leaves `userId`: the others count at least the floor, all of it under the brake. */
function poolLeftCents(userId: string, seat: TeamSeat, spent: ReadonlyMap<string, number>): number {
  const floor = Math.floor(TEAM_SEAT_DAILY_COST_CAP_CENTS * TEAM_MEMBER_FLOOR_SHARE);
  const counted = seat.seatedUserIds.reduce(
    (sum, id) => (id === userId ? sum : sum + Math.max(spent.get(id) ?? 0, floor)),
    0,
  );
  const pool = seat.seatsPurchased * TEAM_SEAT_DAILY_COST_CAP_CENTS;
  const brake = TEAM_SEAT_DAILY_COST_CAP_CENTS * TEAM_MEMBER_BRAKE_MULTIPLIER;
  return Math.min(Math.max(0, pool - counted), brake);
}

/**
 * Today's pooled cap for a seat holder in cents, or null when the user holds
 * no paid seat (always null, with no query, while TEAMS_ENABLED is closed to
 * them). A database failure throws once — the caller reports it and falls
 * back — and then reads as "no pool" for FAILURE_TTL_MS.
 */
export async function teamPoolCapCents(userId: string, now = new Date()): Promise<number | null> {
  const seat = await cachedHeldTeamSeat(userId, now.getTime());
  if (!seat) return null;
  if (!seat.seatedUserIds.some((id) => id !== userId))
    return poolLeftCents(userId, seat, new Map());
  const spent = await seatedSpendToday(seat, utcDayKey(now), now.getTime());
  return spent === null ? null : poolLeftCents(userId, seat, spent);
}

/** Test seam: forget every cached pool (and the seats it reads). */
export function __resetTeamPoolCacheForTest(): void {
  spendCache.clear();
  __resetSeatCacheForTest();
}
