/**
 * Model / Provider Fallback — automatic switch to a secondary provider when
 * OpenRouter reports budget exhaustion or weekly key-limit errors.
 *
 * Two distinct failure modes:
 *   - 402 insufficient_credits: swap to a :free OpenRouter model
 *   - 403 "Key limit exceeded (weekly limit)": swap providers entirely
 *     (the limit is per-KEY, so another :free model on the same key fails too)
 */

import type { ProviderName } from "./providers/index.js";

/** Free model used when paid credits run out (same provider) */
export const FALLBACK_MODEL = process.env.FALLBACK_MODEL || "google/gemma-4-31b-it:free";

/** How long to stay on a credit-exhausted state before retrying the paid model */
const CREDIT_RETRY_AFTER_MS = 5 * 60 * 1000; // 5 minutes

/** Per-provider state — tracks when that provider is known to be unavailable */
interface ProviderState {
  /** Credit exhaustion (402). Retry after short cooldown. */
  creditExhaustedAt: number | null;
  /** Weekly key-limit (403). Retry only after UTC-Monday weekly reset. */
  keyLimitedUntil: number | null;
}

const state: Record<ProviderName, ProviderState> = {
  openrouter: { creditExhaustedAt: null, keyLimitedUntil: null },
  gemini: { creditExhaustedAt: null, keyLimitedUntil: null },
};

/**
 * Compute the next OpenRouter weekly-reset boundary.
 * OpenRouter resets free-tier key limits weekly at Monday 00:00 UTC.
 * If we're already past Monday 00:00 UTC this week, target next week's.
 */
function nextWeeklyResetMs(now: Date = new Date()): number {
  const target = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  // getUTCDay: Sun=0, Mon=1 ... Sat=6. Days until next Monday (exclusive of today).
  const daysUntilMonday = (8 - target.getUTCDay()) % 7 || 7;
  target.setUTCDate(target.getUTCDate() + daysUntilMonday);
  return target.getTime();
}

/** Is this provider currently in a credit-exhausted cooldown? */
export function isCreditExhausted(provider: ProviderName): boolean {
  const s = state[provider];
  if (s.creditExhaustedAt === null) return false;
  if (Date.now() - s.creditExhaustedAt > CREDIT_RETRY_AFTER_MS) {
    s.creditExhaustedAt = null;
    console.log(`[MODEL-FALLBACK] ${provider} credit cooldown expired — retrying paid models`);
    return false;
  }
  return true;
}

/** Is this provider locked out until the weekly reset? */
export function isKeyLimited(provider: ProviderName): boolean {
  const s = state[provider];
  if (s.keyLimitedUntil === null) return false;
  if (Date.now() >= s.keyLimitedUntil) {
    s.keyLimitedUntil = null;
    console.log(`[MODEL-FALLBACK] ${provider} weekly reset passed — retrying provider`);
    return false;
  }
  return true;
}

/** Provider is unusable for any reason right now */
export function isProviderUnavailable(provider: ProviderName): boolean {
  return isKeyLimited(provider) || isCreditExhausted(provider);
}

/** Mark a provider as credit-exhausted (402) — short cooldown */
export function markCreditExhausted(provider: ProviderName): void {
  if (state[provider].creditExhaustedAt === null) {
    console.warn(`[MODEL-FALLBACK] ${provider} credits exhausted — cooldown for 5min`);
  }
  state[provider].creditExhaustedAt = Date.now();
}

/** Mark a provider as weekly-key-limited (403) — hold until weekly reset */
export function markKeyLimited(provider: ProviderName): void {
  const until = nextWeeklyResetMs();
  state[provider].keyLimitedUntil = until;
  console.warn(
    `[MODEL-FALLBACK] ${provider} hit weekly key limit — locked out until ${new Date(until).toISOString()}`,
  );
}

/** Manually clear all fallback state (admin / post-topup) */
export function clearFallbackState(provider?: ProviderName): void {
  const targets: ProviderName[] = provider ? [provider] : ["openrouter", "gemini"];
  for (const p of targets) {
    state[p].creditExhaustedAt = null;
    state[p].keyLimitedUntil = null;
  }
  console.log(`[MODEL-FALLBACK] Cleared state for: ${targets.join(", ")}`);
}

/** 402 insufficient_credits — same-provider, swap to :free model */
export function isCreditError(error: unknown): boolean {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status: number }).status
      : undefined;

  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (status === 402) return true;
  return (
    message.includes("402") ||
    message.includes("insufficient credits") ||
    message.includes("budget exceeded") ||
    message.includes("payment required") ||
    message.includes("out of credits")
  );
}

/**
 * 403 weekly key limit — per-KEY, not per-model. Switch providers entirely.
 * Only matches when the 403 is clearly a rate/quota issue, not generic auth.
 */
export function isKeyLimitError(error: unknown): boolean {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status: number }).status
      : undefined;

  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (status === 403 && (message.includes("key limit") || message.includes("limit exceeded"))) {
    return true;
  }
  if (!message) return false;
  return (
    message.includes("key limit exceeded") ||
    message.includes("weekly limit") ||
    message.includes("daily limit exceeded")
  );
}

/** Any budget/quota error — credit exhaustion OR weekly key limit */
export function isBudgetError(error: unknown): boolean {
  return isCreditError(error) || isKeyLimitError(error);
}

/** Returns true if the model is already a free tier model */
export function isFreeModel(model: string): boolean {
  return model.endsWith(":free") || model === "openrouter/free";
}

/** Conservative cost estimate for token ledger/admin UI. */
export function estimateModelCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  if (isFreeModel(model)) return 0;
  // Legacy rough estimate used by the app before model-specific pricing.
  return (promptTokens * 0.00015 + completionTokens * 0.0006) / 1000;
}
