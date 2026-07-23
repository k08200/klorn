/**
 * Model / Provider Fallback — automatic switch to a secondary provider when
 * OpenRouter or Gemini reports budget exhaustion or daily key-limit errors.
 *
 * Two distinct failure modes:
 *   - 402 insufficient_credits: swap to a :free OpenRouter model
 *   - 403/429 provider quota or rate limit: swap providers entirely
 *     (the limit is per-KEY, so another :free model on the same key fails too)
 *
 * OpenRouter free-tier limits (2026): 20 RPM, 50 req/day (1000 with 10+ credits),
 * shared across ALL :free models. Limits reset daily at UTC 00:00 — NOT weekly.
 * Gemini free tier also resets daily at UTC 00:00. We treat both the same way.
 */

/** Free model used when paid credits run out (same provider) */
export const FALLBACK_MODEL = process.env.FALLBACK_MODEL || "google/gemma-4-31b-it:free";

/**
 * Kill switch for every :free-model fallback (the 402 credit swap and the
 * :free entries of the retirement chain). Hosted prod sets
 * DISABLE_FREE_MODEL_FALLBACK=true: OpenRouter's :free endpoints route to
 * hosts that may train on request data (verified 2026-07-03 —
 * gemma-4-31b-it:free serves via Google AI Studio free tier + OpenInference),
 * which would break the privacy policy's Limited Use no-train commitment.
 * With the account-level "free endpoints that may train" toggle off those
 * calls are refused by OpenRouter anyway; this switch skips the doomed round
 * trips so a 402 fails over straight to the next provider (Gemini direct,
 * paid tier). Self-host default (unset) keeps the $0 degradation net — the
 * operator owns their data policy. Read at call time so tests can flip it
 * without module resets.
 */
export function isFreeModelFallbackDisabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env.DISABLE_FREE_MODEL_FALLBACK ?? "").trim().toLowerCase(),
  );
}

/** How long to stay on a credit-exhausted state before retrying the paid model */
const CREDIT_RETRY_AFTER_MS = 5 * 60 * 1000; // 5 minutes

/** Per-provider state — tracks when that provider is known to be unavailable */
interface ProviderState {
  /** Credit exhaustion (402). Retry after short cooldown. */
  creditExhaustedAt: number | null;
  /** Provider quota/rate limit. Retry only after next UTC-midnight daily reset. */
  keyLimitedUntil: number | null;
}

// Map (not a plain object) so a malicious quotaKey like "__proto__" or
// "constructor" can never poison Object.prototype. quotaKeys flow in from
// JWT userIds ("openrouter:user:<uuid>") and from the admin clear endpoint,
// both of which CodeQL classifies as user-controlled.
const state = new Map<string, ProviderState>();

function providerState(provider: string): ProviderState {
  let s = state.get(provider);
  if (!s) {
    s = { creditExhaustedAt: null, keyLimitedUntil: null };
    state.set(provider, s);
  }
  return s;
}

/** Strip control characters so log entries can't be forged via injected newlines. */
function safeLogToken(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").slice(0, 200);
}

/**
 * Compute the next provider daily-reset boundary.
 * Both OpenRouter free tier and Gemini free tier reset at UTC 00:00.
 * Always targets the NEXT UTC midnight (never today's).
 */
export function nextDailyResetMs(now: Date = new Date()): number {
  const target = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime();
}

/** Is this provider currently in a credit-exhausted cooldown? */
export function isCreditExhausted(provider: string): boolean {
  const s = providerState(provider);
  if (s.creditExhaustedAt === null) return false;
  if (Date.now() - s.creditExhaustedAt > CREDIT_RETRY_AFTER_MS) {
    s.creditExhaustedAt = null;
    console.log(
      `[MODEL-FALLBACK] ${safeLogToken(provider)} credit cooldown expired — retrying paid models`,
    );
    return false;
  }
  return true;
}

/** Is this provider locked out until the daily reset? */
export function isKeyLimited(provider: string): boolean {
  const s = providerState(provider);
  if (s.keyLimitedUntil === null) return false;
  if (Date.now() >= s.keyLimitedUntil) {
    s.keyLimitedUntil = null;
    console.log(
      `[MODEL-FALLBACK] ${safeLogToken(provider)} daily reset passed — retrying provider`,
    );
    return false;
  }
  return true;
}

/** Provider is unusable for any reason right now */
export function isProviderUnavailable(provider: string): boolean {
  return isKeyLimited(provider) || isCreditExhausted(provider);
}

/** Mark a provider as credit-exhausted (402) — short cooldown */
export function markCreditExhausted(provider: string): void {
  const s = providerState(provider);
  if (s.creditExhaustedAt === null) {
    console.warn(
      `[MODEL-FALLBACK] ${safeLogToken(provider)} credits exhausted — cooldown for 5min`,
    );
  }
  s.creditExhaustedAt = Date.now();
}

/**
 * Granularity of the key-limit signal. Matters because Gemini and OpenRouter
 * return 429s for both per-minute RPM trips AND per-day quota exhaustion —
 * locking a provider out for ~21h after a one-minute RPM burst is far too
 * punitive, so we shorten that case dramatically.
 */
export type CooldownKind = "minute" | "daily" | "ambiguous";

const MINUTE_COOLDOWN_MS = 5 * 60_000;
const AMBIGUOUS_COOLDOWN_MS = 60 * 60_000;

/**
 * Inspect an error message to decide how long to lock the provider out.
 * Both OpenRouter and Gemini surface their quota window in the message body
 * ("per minute" / "per day" / "daily limit"). When that signal is absent
 * we default to "ambiguous" (1h) rather than "daily" so a transient 429
 * doesn't burn most of the day.
 */
export function classifyKeyLimitError(error: unknown): CooldownKind {
  const msg = error instanceof Error ? error.message.toLowerCase() : "";
  if (!msg) return "ambiguous";
  if (/per[\s-]?minute|per[\s-]?min\b/.test(msg)) return "minute";
  if (/per[\s-]?day|daily limit|weekly limit/.test(msg)) return "daily";
  return "ambiguous";
}

/**
 * Mark a provider as quota/rate-limited. Pass the original error so the
 * classifier can pick a cooldown that matches the actual quota window —
 * RPM trips get 5 minutes; per-day quotas get held until next UTC midnight;
 * anything ambiguous gets 1 hour.
 */
export function markKeyLimited(provider: string, error?: unknown): void {
  const s = providerState(provider);
  const kind: CooldownKind = error === undefined ? "ambiguous" : classifyKeyLimitError(error);
  let until: number;
  let label: string;
  switch (kind) {
    case "minute":
      until = Date.now() + MINUTE_COOLDOWN_MS;
      label = "RPM (per-minute)";
      break;
    case "daily":
      until = nextDailyResetMs();
      label = "daily quota";
      break;
    default:
      until = Date.now() + AMBIGUOUS_COOLDOWN_MS;
      label = "ambiguous quota error";
      break;
  }
  s.keyLimitedUntil = until;
  console.warn(
    `[MODEL-FALLBACK] ${safeLogToken(provider)} hit ${label} — locked out until ${new Date(until).toISOString()}`,
  );
}

/** Manually clear all fallback state (admin / post-topup) */
export function clearFallbackState(provider?: string): void {
  const targets = provider ? [provider] : Array.from(state.keys());
  for (const p of targets) {
    const s = providerState(p);
    s.creditExhaustedAt = null;
    s.keyLimitedUntil = null;
  }
  console.log(`[MODEL-FALLBACK] Cleared state for: ${targets.map(safeLogToken).join(", ")}`);
}

/** Read-only snapshot of why a provider quotaKey is currently unavailable */
export interface ProviderCooldownInfo {
  quotaKey: string;
  creditRetryAt: Date | null;
  keyLimitedUntil: Date | null;
}

export function getProviderCooldownInfo(quotaKey: string): ProviderCooldownInfo {
  const s = providerState(quotaKey);
  return {
    quotaKey,
    creditRetryAt:
      s.creditExhaustedAt === null ? null : new Date(s.creditExhaustedAt + CREDIT_RETRY_AFTER_MS),
    keyLimitedUntil: s.keyLimitedUntil === null ? null : new Date(s.keyLimitedUntil),
  };
}

/**
 * Snapshot the per-user AI provider cooldown state. Used by the readiness
 * check so the dashboard reports "AI unavailable" instead of the stale
 * "Overall OK" when every provider for this user is in cooldown.
 *
 * The four keys mirror how createCompletion routes calls: env-wide keys for
 * the shared Klorn account plus user-supplied keys that override them.
 */
export function snapshotUserProviderCooldowns(userId: string): {
  providers: ProviderCooldownInfo[];
  unavailable: ProviderCooldownInfo[];
} {
  const quotaKeys = [
    "openrouter:env",
    "gemini:env",
    `openrouter:user:${userId}`,
    `gemini:user:${userId}`,
  ];
  const providers = quotaKeys.map(getProviderCooldownInfo);
  const unavailable = providers.filter((info) => isProviderUnavailable(info.quotaKey));
  return { providers, unavailable };
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
 * Provider quota/rate limit — per-KEY, not per-model. Switch providers entirely.
 * Only matches generic statuses when the message is clearly a rate/quota issue,
 * not auth or malformed-request errors.
 */
export function isKeyLimitError(error: unknown): boolean {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status: number }).status
      : undefined;

  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (status === 429) return true;
  if (status === 403 && (message.includes("key limit") || message.includes("limit exceeded"))) {
    return true;
  }
  if (!message) return false;
  // SDK errors often surface as `Error("429 ...")` or `Error("403 ...")` with
  // the HTTP status prefixed into the message. Match those numerically so
  // we don't depend on the broader phrase "provider returned error" — which
  // also fires on invalid-model / transient 5xx errors and would otherwise
  // flip the provider into a week-long cooldown unnecessarily.
  if (/^\s*429\b/.test(message)) return true;
  if (
    /^\s*403\b/.test(message) &&
    (message.includes("key limit") || message.includes("limit exceeded"))
  ) {
    return true;
  }
  return (
    message.includes("key limit exceeded") ||
    message.includes("weekly limit") ||
    message.includes("daily limit exceeded") ||
    message.includes("rate limit") ||
    message.includes("rate-limit") ||
    message.includes("too many requests") ||
    message.includes("quota exceeded")
  );
}

/** Any budget/quota error — credit exhaustion OR weekly key limit */
export function isBudgetError(error: unknown): boolean {
  return isCreditError(error) || isKeyLimitError(error);
}

/**
 * Transport-level failure — the endpoint itself is unreachable (connection
 * refused/reset, DNS, timeout, undici "fetch failed"). Matters for the
 * local/OpenAI-compat provider: a self-hoster's Ollama being down should
 * fail over to the next configured provider, not hard-fail the request.
 * Deliberately NOT given a cooldown — a local endpoint can come back any
 * second, and for a local-only chain a cooldown would blackhole everything.
 */
export function isConnectionError(error: unknown): boolean {
  if (error == null) return false;
  const code =
    typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  if (/^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|UND_ERR)/.test(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (!message) return false;
  if (
    /econnrefused|econnreset|enotfound|etimedout|ehostunreach|fetch failed|connection error|socket hang up/.test(
      message,
    )
  ) {
    return true;
  }
  // OpenAI SDK wraps transport failures in APIConnectionError with a cause.
  const cause = (error as { cause?: unknown }).cause;
  return cause !== undefined && cause !== error && isConnectionError(cause);
}

/**
 * Provider has no endpoint for the requested model — typically because the
 * model SKU was retired (OpenRouter's "No endpoints found for ..." 404), the
 * caller misspelled an id, or no provider on that platform serves it. The
 * call CAN succeed against a different provider that has the same family
 * (e.g. native Gemini direct API), so we treat this the same as a quota
 * limit for failover purposes: skip this provider, try the next.
 *
 * Deliberately NOT matching every 404 — we narrow to error texts that name
 * a model/endpoint, so a routing-level 404 in a different layer (auth, etc.)
 * is left to its existing handler.
 */
export function isModelUnavailableError(error: unknown): boolean {
  if (error == null || (typeof error !== "object" && !(error instanceof Error))) return false;

  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status: number }).status
      : undefined;

  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message.toLowerCase()
        : "";

  const isModelyText =
    message.includes("no endpoints found") ||
    message.includes("model not found") ||
    message.includes("no allowed providers") ||
    message.includes("model has been deprecated") ||
    message.includes("model is unavailable") ||
    message.includes("invalid model");

  if (isModelyText) return true;

  // Bare 404 status alone is too broad (route 404s, auth 404s). Require the
  // message to mention a model/endpoint, OR the literal phrase that OpenRouter
  // uses for retired SKUs.
  const isStatus404 = status === 404 || /^\s*404\b/.test(message);
  if (isStatus404 && (message.includes("endpoint") || message.includes("model"))) {
    return true;
  }

  return false;
}

/** Returns true if the model is already a free tier model */
export function isFreeModel(model: string): boolean {
  return model.endsWith(":free") || model === "openrouter/free";
}

/** USD per MILLION tokens (input = prompt, output = completion). */
interface ModelRateUsdPerMTok {
  input: number;
  output: number;
}

/**
 * Model-family pricing table. Matched case-insensitively: EVERY substring in
 * `match` must appear in the model id; first matching row wins, so keep
 * specific rows (flash-lite, gpt+mini) above their generic family row.
 *
 * Rates are current public list prices (2026-07), deliberately rounded UP
 * where a family spans several SKUs — this feeds protective cost caps, so
 * overestimating slightly is safe and underestimating is the bug (the old
 * code priced every paid model at flash rates, undercounting sonnet ~20x).
 */
const MODEL_RATES: ReadonlyArray<{ match: readonly string[]; rate: ModelRateUsdPerMTok }> = [
  { match: ["gemini", "flash-lite"], rate: { input: 0.1, output: 0.4 } },
  { match: ["gemini", "flash"], rate: { input: 0.3, output: 2.5 } },
  { match: ["gemini", "pro"], rate: { input: 1.25, output: 10 } },
  { match: ["gemma"], rate: { input: 0.1, output: 0.4 } },
  { match: ["claude", "haiku"], rate: { input: 1, output: 5 } },
  { match: ["claude", "sonnet"], rate: { input: 3, output: 15 } },
  { match: ["claude", "opus"], rate: { input: 15, output: 75 } },
  { match: ["gpt", "mini"], rate: { input: 0.6, output: 2.4 } },
  { match: ["gpt", "nano"], rate: { input: 0.1, output: 0.4 } },
  { match: ["gpt"], rate: { input: 2.5, output: 10 } },
  { match: ["grok"], rate: { input: 3, output: 15 } },
  { match: ["llama"], rate: { input: 0.4, output: 0.8 } },
  { match: ["deepseek"], rate: { input: 0.6, output: 2.2 } },
  { match: ["mistral"], rate: { input: 2, output: 6 } },
];

/**
 * Unknown paid models price at the sonnet tier, NOT at flash rates: a new
 * frontier model landing in CHAT_MODEL before this table learns it must be
 * over-billed against the caps, never 20x under-billed (the original bug).
 */
const DEFAULT_MODEL_RATE: ModelRateUsdPerMTok = { input: 3, output: 15 };

/** Resolve the per-M-token USD rate for a model id (family-prefix match). */
export function resolveModelRateUsdPerMTok(model: string): ModelRateUsdPerMTok {
  const id = model.toLowerCase();
  const hit = MODEL_RATES.find((entry) => entry.match.every((needle) => id.includes(needle)));
  return hit?.rate ?? DEFAULT_MODEL_RATE;
}

const TOKENS_PER_M = 1_000_000;

/**
 * Model-aware cost estimate feeding the token ledger, admin UI, and the
 * daily cost caps (via estimatePrebillCents / trueUpCostLedgers).
 */
export function estimateModelCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  if (isFreeModel(model)) return 0;
  const rate = resolveModelRateUsdPerMTok(model);
  const prompt = Number.isFinite(promptTokens) && promptTokens > 0 ? promptTokens : 0;
  const completion =
    Number.isFinite(completionTokens) && completionTokens > 0 ? completionTokens : 0;
  return (prompt * rate.input + completion * rate.output) / TOKENS_PER_M;
}
