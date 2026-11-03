/**
 * Admission for the v3 facts shadow. The shadow is measurement: it may only
 * use capacity the v2 judge and the user's own features will not need, so it
 * skips (never waits) whenever anything is tight:
 *  - one shadow extraction in flight per process (an initial sync of hundreds
 *    of mails is sampled, not queued behind the judge in the shared pacer);
 *  - at most half of the user's per-minute and daily background call budget
 *    (the judge's RPM slots and count headroom stay free);
 *  - a free background pacer slot with nobody queued (it never waits behind
 *    the judge's calls in the shared pacer);
 *  - the money it may spend: at least JUDGE_V3_SHADOW_FLOOR_CENTS (25¢) of the
 *    user's ordinary budget must remain (the judge reserve sits above that),
 *    the shadow's own spend today stays under JUDGE_V3_SHADOW_DAILY_USD
 *    ($0.15) per user and JUDGE_V3_SHADOW_GLOBAL_DAILY_USD for everyone
 *    (default 10% of the global ceiling, which has no judge reserve), and the
 *    global ceiling must be open.
 */

import { checkCostGate, checkGlobalCostGate } from "../../billing/cost-guard.js";
import { getUserUsage, type UserUsageSnapshot } from "../../billing/quota-limiter.js";
import { GLOBAL_DAILY_COST_CAP_CENTS } from "../../config.js";
import { db } from "../../db.js";
import { backgroundLlmPacer, type PacerLoad } from "../../llm/background-pacer.js";

const DEFAULT_SHADOW_FLOOR_CENTS = 25;
const DEFAULT_SHADOW_DAILY_USD = 0.15;
/** Share of the global daily ceiling the shadow may take, all users together. */
const GLOBAL_SHADOW_SHARE = 0.1;
/** Global shadow cap when the global ceiling is off (0 = uncapped). */
const DEFAULT_GLOBAL_SHADOW_DAILY_USD = 5;
/** The shadow never takes more than this share of the per-user call budget. */
export const SHADOW_MAX_CALL_SHARE = 0.5;
export const MAX_SHADOW_IN_FLIGHT = 1;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const shadowFloorCents = () =>
  envNumber("JUDGE_V3_SHADOW_FLOOR_CENTS", DEFAULT_SHADOW_FLOOR_CENTS);
export const shadowDailyUsd = () =>
  envNumber("JUDGE_V3_SHADOW_DAILY_USD", DEFAULT_SHADOW_DAILY_USD);

/** The shadow's spend cap across all users per UTC day. */
export function globalShadowDailyUsd(globalCapCents = GLOBAL_DAILY_COST_CAP_CENTS): number {
  const fallback =
    globalCapCents > 0
      ? (globalCapCents / 100) * GLOBAL_SHADOW_SHARE
      : DEFAULT_GLOBAL_SHADOW_DAILY_USD;
  return envNumber("JUDGE_V3_SHADOW_GLOBAL_DAILY_USD", fallback);
}

/** Global ceiling (cents) kept free of shadow spend: the share the shadow may take. */
export function globalShadowReserveCents(globalCapCents = GLOBAL_DAILY_COST_CAP_CENTS): number {
  return globalCapCents > 0 ? globalCapCents * GLOBAL_SHADOW_SHARE : 0;
}

/** Pure: a free pacer slot and an empty queue. */
export function pacerHasRoom(load: PacerLoad): boolean {
  return load.waiting === 0 && load.active < load.maxConcurrent;
}

export interface GateView {
  allowed: boolean;
  remainingCents: number;
  capCents: number;
}

/** Pure: does the user's ordinary budget keep the floor after the shadow? */
export function shadowHeadroomOk(gate: GateView, floorCents: number): boolean {
  if (!gate.allowed) return false;
  if (gate.capCents <= 0) return true;
  return gate.remainingCents >= floorCents;
}

/** Pure: is at least half of the user's call budget still free? */
export function callShareOk(u: UserUsageSnapshot): boolean {
  return (
    u.rpmUsed < u.rpmCap * SHADOW_MAX_CALL_SHARE &&
    u.backgroundDailyUsed < u.backgroundDailyCap * SHADOW_MAX_CALL_SHARE
  );
}

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Shadow spend today: one user's, or everyone's when userId is null. */
async function shadowSpentTodayUsd(userId: string | null, now: Date): Promise<number> {
  const agg = await db.attentionFacts.aggregate({
    where: { ...(userId ? { userId } : {}), extractedAt: { gte: utcDayStart(now) } },
    _sum: { costUsd: true },
  });
  return agg._sum.costUsd ?? 0;
}

/** The all-users sum is read at most once a minute per process: it scans the day. */
const GLOBAL_SPEND_CACHE_MS = 60_000;
let globalSpend: { at: number; day: number; usd: number } | null = null;

async function globalShadowSpentTodayUsd(now: Date): Promise<number> {
  const day = utcDayStart(now).getTime();
  if (
    globalSpend &&
    globalSpend.day === day &&
    now.getTime() - globalSpend.at < GLOBAL_SPEND_CACHE_MS
  ) {
    return globalSpend.usd;
  }
  const usd = await shadowSpentTodayUsd(null, now);
  globalSpend = { at: now.getTime(), day, usd };
  return usd;
}

/** Test hook: forget the cached all-users sum. */
export function _resetGlobalShadowSpendCache(): void {
  globalSpend = null;
}

export type BudgetVerdict =
  | "ok"
  | "calls"
  | "user_budget"
  | "shadow_budget"
  | "global_budget"
  | "global_shadow_budget"
  | "pacer_busy"
  | "budget_unknown";

export async function shadowBudgetVerdict(
  userId: string,
  now = new Date(),
): Promise<BudgetVerdict> {
  if (!callShareOk(getUserUsage(userId))) return "calls";
  if (!pacerHasRoom(backgroundLlmPacer.load())) return "pacer_busy";
  let gate: GateView;
  let global: { allowed: boolean; remainingCents: number };
  let spent: number;
  let spentAll: number;
  try {
    [gate, global, spent, spentAll] = await Promise.all([
      checkCostGate(userId),
      checkGlobalCostGate(),
      shadowSpentTodayUsd(userId, now),
      globalShadowSpentTodayUsd(now),
    ]);
  } catch {
    // Can't tell what the shadow may spend: skip quietly (no Sentry per mail).
    return "budget_unknown";
  }
  if (!shadowHeadroomOk(gate, shadowFloorCents())) return "user_budget";
  // The global ceiling has no judge reserve of its own: keep its last share free.
  if (!global.allowed || global.remainingCents < globalShadowReserveCents()) return "global_budget";
  if (spent >= shadowDailyUsd()) return "shadow_budget";
  if (spentAll >= globalShadowDailyUsd()) return "global_shadow_budget";
  return "ok";
}

let inFlight = 0;

/** Run fn only if no other shadow extraction is in flight; otherwise null. */
export async function withShadowSlot<T>(fn: () => Promise<T>): Promise<T | null> {
  if (inFlight >= MAX_SHADOW_IN_FLIGHT) return null;
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
  }
}
