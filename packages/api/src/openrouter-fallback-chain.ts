/**
 * OpenRouter free-model fallback chain.
 *
 * OpenRouter retires :free SKUs without notice (e.g. google/gemini-2.5-flash:free
 * silently became 404 in early June 2026). The autonomous agent — which runs as a
 * background cron — has no way to recover from that, so every cycle was failing
 * until an operator manually updated the AGENT_MODEL env var.
 *
 * When the configured model returns 404 / "no endpoints found" on OpenRouter,
 * createCompletion walks this chain on the same provider before giving up. Each
 * entry is a known-stable :free SKU; the chain is ordered so the most
 * capable / well-tooled model comes first.
 *
 * Override the chain via OPENROUTER_FALLBACK_CHAIN (comma-separated). Useful
 * when OpenRouter publishes a hot new free SKU you want to prefer, or to
 * react quickly to a fleet of retirements without a redeploy.
 */

import { isCreditError, isKeyLimitError, isModelUnavailableError } from "./model-fallback.js";

// Verified against the live catalog 2026-06-12 — three of the previous five
// entries (deepseek-r1, qwen-2.5-72b, mistral-small) had already been retired
// upstream, which is exactly the failure mode the daily catalog check now
// alerts on. Ordered most-capable-first among currently-listed :free SKUs
// with reliable tool support.
export const DEFAULT_OPENROUTER_FALLBACK_CHAIN: ReadonlyArray<string> = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "openai/gpt-oss-120b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-31b-it:free",
];

export function parseFallbackChain(envValue: string | undefined): string[] {
  if (!envValue) return [...DEFAULT_OPENROUTER_FALLBACK_CHAIN];
  const parts = envValue
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [...DEFAULT_OPENROUTER_FALLBACK_CHAIN];
}

export const OPENROUTER_FALLBACK_CHAIN: ReadonlyArray<string> = parseFallbackChain(
  process.env.OPENROUTER_FALLBACK_CHAIN,
);

/**
 * Walk a fallback chain looking for a successful call.
 *
 * Behavior:
 *   - Skips `alreadyTriedModel` so we never retry the original failure.
 *   - Each entry tried in order. Returns the FIRST success.
 *   - If the executor throws `isModelUnavailableError` on an entry, try the next.
 *   - If it throws a credit/quota error, bail out and return null (caller
 *     should move to the next *provider*, not keep burning this one).
 *   - Any other error is re-thrown so the caller sees the real failure.
 *   - Returns null if the whole chain was exhausted without success.
 */
export async function walkFallbackChain<T>(
  chain: ReadonlyArray<string>,
  alreadyTriedModel: string | undefined,
  execute: (model: string) => Promise<T>,
): Promise<T | null> {
  for (const candidate of chain) {
    if (candidate === alreadyTriedModel) continue;
    try {
      return await execute(candidate);
    } catch (err) {
      if (isModelUnavailableError(err)) continue;
      if (isCreditError(err) || isKeyLimitError(err)) return null;
      throw err;
    }
  }
  return null;
}
