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
