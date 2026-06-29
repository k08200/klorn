/**
 * Per-user daily LLM cost gate.
 *
 * Wraps every paid LLM call. Reads the `LlmCostLedger` row for today,
 * compares against `DAILY_COST_CAP_CENTS`, and blocks the call once the
 * cap is exceeded. Successful calls increment the ledger.
 *
 * The previous code path only logged `estimateModelCostUsd()` — no hard
 * stop. A single runaway agent loop could rack up real money. With this
 * gate the worst case is one over-the-cap call (the one that crosses the
 * threshold), then every subsequent call short-circuits.
 *
 * Free models (cost = 0) still flow through here so we record the
 * `callCount` and `lastModel` for visibility, but they never trip the cap.
 */

import { DAILY_COST_CAP_CENTS, GLOBAL_DAILY_COST_CAP_CENTS } from "./config.js";
import { prisma } from "./db.js";

export interface CostGateResult {
  allowed: boolean;
  remainingCents: number;
  usedCents: number;
  capCents: number;
  reason?: string;
}

function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Check whether `userId` is allowed to make another paid LLM call today.
 * Reads but does not mutate. Cap = 0 disables the gate entirely.
 */
export async function checkCostGate(userId: string): Promise<CostGateResult> {
  const cap = DAILY_COST_CAP_CENTS;
  if (cap <= 0) {
    return { allowed: true, remainingCents: Number.POSITIVE_INFINITY, usedCents: 0, capCents: 0 };
  }
  const row = await prisma.llmCostLedger.findUnique({
    where: { userId_dayKey: { userId, dayKey: utcDayKey() } },
    select: { cents: true },
  });
  const used = row?.cents ?? 0;
  if (used >= cap) {
    return {
      allowed: false,
      remainingCents: 0,
      usedCents: used,
      capCents: cap,
      reason: `Daily cap reached (${used}¢/${cap}¢)`,
    };
  }
  return { allowed: true, remainingCents: cap - used, usedCents: used, capCents: cap };
}

/**
 * Record an LLM call against today's ledger. `cents` should be the actual
 * estimated cost in USD cents (rounded up to the nearest integer). Use 0
 * for free models so the call still counts toward usage tracking.
 */
export async function recordCostUsage(
  userId: string,
  cents: number,
  model: string | null,
): Promise<{ totalCents: number; overCap: boolean } | null> {
  const safeCents = Math.max(0, Math.round(cents));
  const dayKey = utcDayKey();
  try {
    // The increment is atomic, and we read the post-increment total back so the
    // caller can close the check-then-act TOCTOU: two concurrent calls can both
    // pass the read-side checkCostGate, but only the increments that actually
    // cross the cap report overCap=true.
    const row = await prisma.llmCostLedger.upsert({
      where: { userId_dayKey: { userId, dayKey } },
      create: {
        userId,
        dayKey,
        cents: safeCents,
        callCount: 1,
        lastModel: model,
      },
      update: {
        cents: { increment: safeCents },
        callCount: { increment: 1 },
        lastModel: model ?? undefined,
      },
      select: { cents: true },
    });
    const cap = DAILY_COST_CAP_CENTS;
    return { totalCents: row.cents, overCap: cap > 0 && row.cents > cap };
  } catch (err) {
    // The ledger is best-effort accounting; never fail the user-facing call
    // because of a write here.
    console.warn("[cost-guard] failed to record usage:", err);
    return null;
  }
}

// Moved to cents.ts (leaf module — llm-usage.ts needs it without dragging
// in this file's db.js/Prisma .env-autoload side effect). Re-exported so
// existing importers keep working.
export { usdToCents } from "./cents.js";

// ── Global daily ceiling ──────────────────────────────────────────────────
// In-memory aggregate across every LLM call (per-user AND system-initiated),
// reset at UTC-day rollover. This is the circuit breaker the per-user gate
// can't be: it sees userId-less calls. It is intentionally in-memory — the
// deployment is a single instance, and this is a runaway-burst breaker, not
// exact accounting. A process restart resets it (rare; per-user DB caps still
// hold). If the app is ever scaled out, this must move to a shared store.
const globalSpend = { dayKey: utcDayKey(), cents: 0 };

function rollGlobalDayIfNeeded(): void {
  const today = utcDayKey();
  if (globalSpend.dayKey !== today) {
    globalSpend.dayKey = today;
    globalSpend.cents = 0;
  }
}

/** Check whether the global daily ceiling still allows another paid call. */
export function checkGlobalCostGate(): CostGateResult {
  const cap = GLOBAL_DAILY_COST_CAP_CENTS;
  if (cap <= 0) {
    return { allowed: true, remainingCents: Number.POSITIVE_INFINITY, usedCents: 0, capCents: 0 };
  }
  rollGlobalDayIfNeeded();
  const used = globalSpend.cents;
  if (used >= cap) {
    return {
      allowed: false,
      remainingCents: 0,
      usedCents: used,
      capCents: cap,
      reason: `Global daily cap reached (${used}¢/${cap}¢)`,
    };
  }
  return { allowed: true, remainingCents: cap - used, usedCents: used, capCents: cap };
}

/** Record cost against the global ceiling. Called for every LLM call. */
export function recordGlobalCostUsage(cents: number): void {
  rollGlobalDayIfNeeded();
  globalSpend.cents += Math.max(0, Math.round(cents));
}

/** Test seam: reset the in-memory global accumulator. */
export function __resetGlobalSpendForTest(): void {
  globalSpend.dayKey = utcDayKey();
  globalSpend.cents = 0;
}
