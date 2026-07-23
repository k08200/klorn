/**
 * Leaf money-math helpers. Lives outside cost-guard.ts on purpose:
 * cost-guard pulls db.js, and Prisma's client auto-loads the local .env —
 * which injects real API keys into process.env at import time. Modules that
 * only need the arithmetic (e.g. llm-usage.ts, which openai.ts imports
 * statically) must not drag that side effect into the provider-registry
 * init path — it flips unit tests from offline to live-LLM whenever a
 * local .env exists.
 */

/** Convert a USD float (e.g. 0.0042) to integer cents rounded up. */
export function usdToCents(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.max(1, Math.ceil(usd * 100));
}

/** 0.01¢ — the granularity of fractional-cent accounting. */
const CENT_PRECISION = 100;

/**
 * Convert a USD float to FRACTIONAL cents at 0.01¢ granularity, rounded up.
 *
 * This is the cost-cap accounting path. usdToCents' 1¢ minimum turned a
 * ~0.05¢ flash classification into a 1¢ charge — ~20x over-billing that
 * tripped the $10 global ceiling at ~1,000 classifications/day. Sub-cent
 * costs must accumulate at their true size; rounding is still UP (ceil) so
 * the caps stay protective.
 */
export function usdToFractionalCents(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  // Round to micro-dollars first so float noise (0.001 * 1e4 = 10.000…02)
  // can't ceil an exact value up a whole 0.01¢ step.
  const microUsd = Math.round(usd * 1_000_000);
  return Math.ceil(microUsd / 100) / CENT_PRECISION;
}
