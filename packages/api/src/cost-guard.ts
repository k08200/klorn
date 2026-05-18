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

import { DAILY_COST_CAP_CENTS } from "./config.js";
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
): Promise<void> {
  const safeCents = Math.max(0, Math.round(cents));
  const dayKey = utcDayKey();
  try {
    await prisma.llmCostLedger.upsert({
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
    });
  } catch (err) {
    // The ledger is best-effort accounting; never fail the user-facing call
    // because of a write here.
    console.warn("[cost-guard] failed to record usage:", err);
  }
}

/** Convert a USD float (e.g. 0.0042) to integer cents rounded up. */
export function usdToCents(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.max(1, Math.ceil(usd * 100));
}
