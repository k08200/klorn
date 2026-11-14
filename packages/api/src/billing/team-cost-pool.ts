/**
 * The pooled Klorn Teams LLM budget (pricing-tiers.md: $0.80 / seat / day,
 * pooled across the team; "one person can use more on a day the others use
 * less").
 *
 * A seat holder may spend what the pool has left: seatsPurchased x
 * TEAM_SEAT_DAILY_COST_CAP_CENTS minus today's spend by the organization's
 * other seated members, bounded per member by the pricing doc's 10x anomaly
 * brake (a runaway loop on one account must not drain a 150-seat pool).
 * cost-guard.ts never lets it fall below the member's own plan cap.
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

/**
 * The pool is re-read at most this often per user. resolveCapCents runs twice
 * per LLM call (check, then record); without the window every judge and chat
 * call would add three queries. Staleness is bounded: other members' spend in
 * the last 30 s, and a lapsed or removed seat keeps its pool for 30 s.
 */
const POOL_TTL_MS = 30_000;
const POOL_CACHE_MAX = 5_000;

const poolCache = new Map<string, { at: number; capCents: number | null }>();

function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function computePoolCapCents(userId: string, now: Date): Promise<number | null> {
  const seat = await heldTeamSeat(userId);
  if (!seat) return null;
  const pool = seat.seatsPurchased * TEAM_SEAT_DAILY_COST_CAP_CENTS;
  const others = seat.seatedUserIds.filter((id) => id !== userId);
  const spent =
    others.length === 0
      ? 0
      : ((
          await prisma.llmCostLedger.aggregate({
            where: { userId: { in: others }, dayKey: utcDayKey(now) },
            _sum: { cents: true },
          })
        )._sum.cents ?? 0);
  const brake = TEAM_SEAT_DAILY_COST_CAP_CENTS * TEAM_MEMBER_BRAKE_MULTIPLIER;
  return Math.min(Math.max(0, pool - spent), brake);
}

/**
 * Today's pooled cap for a seat holder in cents, or null when the user holds
 * no paid seat (always null, with no query, while TEAMS_ENABLED is closed to
 * them). Throws on a database failure; the caller decides the fallback.
 */
export async function teamPoolCapCents(userId: string, now = new Date()): Promise<number | null> {
  const cached = poolCache.get(userId);
  if (cached && now.getTime() - cached.at < POOL_TTL_MS) return cached.capCents;
  const capCents = await computePoolCapCents(userId, now);
  if (poolCache.size >= POOL_CACHE_MAX) poolCache.clear();
  poolCache.set(userId, { at: now.getTime(), capCents });
  return capCents;
}

/** Test seam: forget every cached pool. */
export function __resetTeamPoolCacheForTest(): void {
  poolCache.clear();
}
