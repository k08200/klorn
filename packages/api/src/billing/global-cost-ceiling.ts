/**
 * The global daily LLM ceiling (cost-guard.ts checkGlobalCostGate), sized so a
 * paying Klorn Teams pool can never sit above it.
 *
 * pricing-tiers.md (founder, 2026-11-08, LOCKED): "The global breaker scales
 * with active users (3 × the sum of active users' targets + a system
 * allowance). No fixed all-users ceiling." The full breaker is PR6 and not
 * built. Until it is, the fixed GLOBAL_DAILY_COST_CAP_CENTS stays the base for
 * everything PR6 will replace (individual plans and the system allowance), and
 * paid seats get the doc's share now: every seat of an organization whose
 * subscription bears seats (active, trialing) adds 3 × the seat target
 * (TEAM_SEAT_DAILY_COST_CAP_CENTS). Purchased seats count, like the pool
 * itself (team-cost-pool.ts): unfilled paid seats feed the filled members.
 *
 * Dark while TEAMS_ENABLED is off: the ceiling is the base exactly, and
 * nothing is queried. In cohort mode only organizations with a cohort member
 * count, the only ones whose pool is in force. A base of 0 disables the
 * ceiling as before (DB-less eval/canary jobs rely on that).
 *
 * Reads the organizations' seat counts and statuses only — never a member,
 * mail or spend.
 */

import {
  cohortRestriction,
  GLOBAL_DAILY_COST_CAP_CENTS,
  TEAM_SEAT_DAILY_COST_CAP_CENTS,
  TEAMS_FLAG,
} from "../config.js";
import { prisma } from "../db.js";
import { SEAT_BEARING_STATUS_LIST } from "../org/effective-tier.js";
import { captureError } from "../sentry.js";

/** pricing-tiers.md "global breaker": 3 × the sum of active users' targets. */
export const GLOBAL_BREAKER_TARGET_MULTIPLIER = 3;

/**
 * The gate runs twice per paid LLM call (check, then record): the seat sum is
 * re-read at most once a minute. A bought or lapsed seat moves the ceiling
 * within that minute.
 */
const SEATS_TTL_MS = 60_000;
/** A failed read is retried after 5 s, not on every call (no report flood). */
const FAILURE_TTL_MS = 5_000;

interface CachedSeats {
  /** Which organizations were counted: the flag's cohort restriction. */
  scope: string;
  expiresAt: number;
  cents: number;
}

let cached: CachedSeats | null = null;

async function readSeatBreakerCents(cohort: readonly string[] | null): Promise<number> {
  const seats = await prisma.organization.aggregate({
    where: {
      subscriptionStatus: { in: [...SEAT_BEARING_STATUS_LIST] },
      ...(cohort ? { memberships: { some: { userId: { in: [...cohort] } } } } : {}),
    },
    _sum: { seatsPurchased: true },
  });
  const paid = Math.max(0, seats._sum.seatsPurchased ?? 0);
  return paid * TEAM_SEAT_DAILY_COST_CAP_CENTS * GLOBAL_BREAKER_TARGET_MULTIPLIER;
}

/**
 * What the paid seat pools add to the global ceiling today, in cents: 0, with
 * no query, while TEAMS_ENABLED reaches no one. A failed read is reported and
 * answers 0 (the base ceiling, never a larger one).
 */
export async function teamSeatBreakerCents(now = Date.now()): Promise<number> {
  const restriction = cohortRestriction([TEAMS_FLAG]);
  if (restriction.kind === "none") return 0;
  const cohort = restriction.kind === "only" ? restriction.userIds : null;
  if (cohort !== null && cohort.length === 0) return 0;
  const scope = cohort === null ? "all" : [...cohort].sort().join(",");
  if (cached && cached.scope === scope && now < cached.expiresAt) return cached.cents;
  try {
    const cents = await readSeatBreakerCents(cohort);
    cached = { scope, expiresAt: now + SEATS_TTL_MS, cents };
    return cents;
  } catch (err) {
    console.warn("[cost-guard] seat pool sum failed, using the base global ceiling:", err);
    captureError(err, { tags: { scope: "cost-guard.global-seat-pools" } });
    cached = { scope, expiresAt: now + FAILURE_TTL_MS, cents: 0 };
    return 0;
  }
}

/**
 * The global daily ceiling in force, in cents: the base plus the paid seat
 * pools' share. 0 when the base is 0 (the ceiling is disabled).
 */
export async function globalDailyCapCents(): Promise<number> {
  const base = GLOBAL_DAILY_COST_CAP_CENTS;
  if (base <= 0) return 0;
  return base + (await teamSeatBreakerCents());
}

/** Test seam: forget the cached seat sum. */
export function __resetGlobalCeilingCacheForTest(): void {
  cached = null;
}
