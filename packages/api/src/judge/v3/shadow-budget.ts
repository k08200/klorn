/**
 * Admission for the v3 facts shadow. The shadow is measurement: it may only
 * use capacity the v2 judge and the user's own features will not need, so it
 * skips (never waits) whenever anything is tight:
 *  - one shadow extraction in flight per process (an initial sync of hundreds
 *    of mails is sampled, not queued behind the judge in the shared pacer);
 *  - at most half of the user's per-minute and daily background call budget
 *    (the judge's RPM slots and count headroom stay free);
 *  - the money it may spend: at least JUDGE_V3_SHADOW_FLOOR_CENTS (25¢) of the
 *    user's ordinary budget must remain (the judge reserve sits above that),
 *    the shadow's own spend today stays under JUDGE_V3_SHADOW_DAILY_USD
 *    ($0.15), and the global ceiling must be open.
 */

import { checkCostGate, checkGlobalCostGate } from "../../billing/cost-guard.js";
import { getUserUsage, type UserUsageSnapshot } from "../../billing/quota-limiter.js";
import { db } from "../../db.js";

const DEFAULT_SHADOW_FLOOR_CENTS = 25;
const DEFAULT_SHADOW_DAILY_USD = 0.15;
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

async function shadowSpentTodayUsd(userId: string, now: Date): Promise<number> {
  const agg = await db.attentionFacts.aggregate({
    where: { userId, extractedAt: { gte: utcDayStart(now) } },
    _sum: { costUsd: true },
  });
  return agg._sum.costUsd ?? 0;
}

export type BudgetVerdict =
  | "ok"
  | "calls"
  | "user_budget"
  | "shadow_budget"
  | "global_budget"
  | "budget_unknown";

export async function shadowBudgetVerdict(
  userId: string,
  now = new Date(),
): Promise<BudgetVerdict> {
  if (!callShareOk(getUserUsage(userId))) return "calls";
  let gate: GateView;
  let global: { allowed: boolean };
  let spent: number;
  try {
    [gate, global, spent] = await Promise.all([
      checkCostGate(userId),
      checkGlobalCostGate(),
      shadowSpentTodayUsd(userId, now),
    ]);
  } catch {
    // Can't tell what the shadow may spend: skip quietly (no Sentry per mail).
    return "budget_unknown";
  }
  if (!shadowHeadroomOk(gate, shadowFloorCents())) return "user_budget";
  if (!global.allowed) return "global_budget";
  if (spent >= shadowDailyUsd()) return "shadow_budget";
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
