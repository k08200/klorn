/**
 * Model / Provider Fallback — per-provider-key cooldown state and the error
 * classifiers createCompletion uses to decide when to move to the next
 * provider in the chain.
 *
 * Failure modes that fail over (each provider has its own key and quota):
 *   - 402 credit exhaustion (Anthropic prepaid balance / spend limit): short
 *     cooldown, next provider
 *   - 403/429 key limit or rate limit: cooldown sized to the quota window
 *     (per-minute, per-day, ambiguous), next provider
 *   - 529 overloaded: next provider, no cooldown
 */

import { redactCredentials } from "../security/credential-redaction.js";

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
// JWT userIds ("anthropic:user:<uuid>") and from the admin clear endpoint,
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
 * Compute the next provider daily-reset boundary (Gemini's daily quotas reset
 * at UTC 00:00). Always targets the NEXT UTC midnight (never today's).
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
 * Granularity of the key-limit signal. Matters because providers return 429s
 * for both per-minute RPM trips AND per-day quota exhaustion —
 * locking a provider out for ~21h after a one-minute RPM burst is far too
 * punitive, so we shorten that case dramatically.
 */
export type CooldownKind = "minute" | "daily" | "ambiguous";

const MINUTE_COOLDOWN_MS = 5 * 60_000;
const AMBIGUOUS_COOLDOWN_MS = 60 * 60_000;

/**
 * Inspect an error message to decide how long to lock the provider out.
 * Providers surface their quota window in the message body
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

/** Max chars of an upstream provider body kept in an operator log line. */
const PROVIDER_MESSAGE_LOG_CAP = 200;

/**
 * Operator-safe rendering of an upstream provider error.
 *
 * The 2026-07/08 judge outage was undiagnosable precisely because this text was
 * thrown away: the log recorded our own classification ("ambiguous quota
 * error") while the provider's actual wording — the only thing that says
 * WHETHER it was an RPM trip, a per-key spend cap, or an account limit — never
 * reached anyone. Keep the provider's wording verbatim, minus anything shaped
 * like a credential, capped so a giant HTML error page can't flood the log.
 *
 * The credential patterns are shared with the playground route and the Sentry
 * boundary (security/credential-redaction.ts). They used to live here alone,
 * and the local copy missed both of Google's key shapes and OpenAI's masked
 * echo form — this text goes to console.warn AND captureError
 * (judge/poc-judge.ts), so a miss here is a miss in error reporting.
 */
export function redactProviderMessage(error: unknown): string | null {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : typeof error === "string"
          ? error
          : "";
  const cleaned = redactCredentials(raw.trim());
  if (!cleaned) return null;
  return cleaned.length > PROVIDER_MESSAGE_LOG_CAP
    ? `${cleaned.slice(0, PROVIDER_MESSAGE_LOG_CAP)}…`
    : cleaned;
}

/**
 * Render an error for an operator log INCLUDING its cause chain.
 *
 * `AllProvidersExhaustedError` deliberately carries a generic, user-safe
 * message; the provider's real failure rides on `cause`. A caller that logs
 * only `err.message` (poc-judge did) therefore records "All AI providers are
 * unavailable" and nothing about why — the exact hole that made the 2026-08-02
 * 429 un-root-causable while the 401 was trivially readable.
 */
export function describeErrorChain(error: unknown, depth = 2): string {
  const head = redactProviderMessage(error) ?? String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  if (depth <= 0 || cause === undefined || cause === null) return head;
  const tail = describeErrorChain(cause, depth - 1);
  return tail && tail !== head ? `${head} (cause: ${tail})` : head;
}

/** Extra context the caller knows and the fallback state does not. */
export interface KeyLimitOptions {
  /**
   * Whether the chain still holds another provider that could serve this
   * request. Defaults to true (the historical multi-provider assumption).
   */
  hasFailover?: boolean;
}

/**
 * Mark a provider as quota/rate-limited. Pass the original error so the
 * classifier can pick a cooldown that matches the actual quota window —
 * RPM trips get 5 minutes; per-day quotas get held until next UTC midnight;
 * anything ambiguous gets 1 hour.
 *
 * Single-provider deployments (one Anthropic key, no second lane) get the
 * ambiguous case shortened to the RPM window. With a failover provider the 1h
 * lockout is just routing — traffic keeps flowing on the other key. With none,
 * it converts one unexplained 429 into an hour with NO LLM at all: the judge
 * drops to the keyword fallback, which caps confidence at 0.55 and therefore
 * cannot reach the PUSH floor (tier-policy.ts push.confidence 0.7). An explicit
 * per-day signal is still honoured — retrying before the UTC reset only burns
 * failed calls.
 */
export function markKeyLimited(
  provider: string,
  error?: unknown,
  options: KeyLimitOptions = {},
): void {
  const s = providerState(provider);
  const kind: CooldownKind = error === undefined ? "ambiguous" : classifyKeyLimitError(error);
  const hasFailover = options.hasFailover !== false;
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
      until = Date.now() + (hasFailover ? AMBIGUOUS_COOLDOWN_MS : MINUTE_COOLDOWN_MS);
      label = hasFailover
        ? "ambiguous quota error"
        : "ambiguous quota error (sole provider — short cooldown)";
      break;
  }
  s.keyLimitedUntil = until;
  const upstream = redactProviderMessage(error);
  console.warn(
    `[MODEL-FALLBACK] ${safeLogToken(provider)} hit ${label} — locked out until ${new Date(until).toISOString()}${
      upstream ? ` — upstream said: ${upstream}` : ""
    }`,
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

/** Which BYOK keys the user has stored (only those lanes are listed). */
export interface UserKeyLanes {
  anthropic?: boolean;
  gemini?: boolean;
}

/**
 * Snapshot the per-user AI provider cooldown state. Used by the readiness
 * check so the dashboard reports "AI unavailable" instead of the stale
 * "Overall OK" when every provider for this user is in cooldown.
 *
 * The keys mirror how createCompletion routes calls: env-wide keys for the
 * shared Klorn account plus user-supplied keys that lead them. Only configured
 * lanes are listed: an unconfigured lane is never in cooldown, so counting it
 * as "available" would keep "every provider in cooldown" from ever reading as
 * an outage.
 */
export function snapshotUserProviderCooldowns(
  userId: string,
  userKeys: UserKeyLanes = {},
): {
  providers: ProviderCooldownInfo[];
  unavailable: ProviderCooldownInfo[];
} {
  const quotaKeys = [
    ...(process.env.ANTHROPIC_API_KEY ? ["anthropic:env"] : []),
    ...(process.env.GEMINI_API_KEY ? ["gemini:env"] : []),
    ...(process.env.OPENAI_COMPAT_BASE_URL ? ["openai-compat:env"] : []),
    ...(userKeys.anthropic ? [`anthropic:user:${userId}`] : []),
    ...(userKeys.gemini ? [`gemini:user:${userId}`] : []),
  ];
  const providers = quotaKeys.map(getProviderCooldownInfo);
  const unavailable = providers.filter((info) => isProviderUnavailable(info.quotaKey));
  return { providers, unavailable };
}

/** 402 insufficient credits / budget exceeded (message or status). */
export function isCreditError(error: unknown): boolean {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status: number }).status
      : undefined;

  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (status === 402) return true;
  return (
    // Anchored: a "402" inside a request id or a token count is not a credit
    // error (it used to cool shared keys down on unrelated 4xx/5xx text).
    /^\s*402\b/.test(message) ||
    message.includes("insufficient credits") ||
    message.includes("budget exceeded") ||
    message.includes("payment required") ||
    message.includes("out of credits")
  );
}

/**
 * Credit exhaustion established by the HTTP status — 402, which is also what
 * the Anthropic adapter turns its prepaid-balance / spend-limit 400s into — or
 * a message that STARTS with 402. Unlike isCreditError it ignores a "402"
 * anywhere else in the text: a request id (`req_…402…`) or a token count
 * (`1402153 tokens`) must not put a shared env key into a credit cooldown.
 */
export function isCreditExhaustionError(error: unknown): boolean {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status: unknown }).status
      : undefined;
  if (status === 402) return true;
  if (typeof status === "number") return false;
  const message = error instanceof Error ? error.message : "";
  return /^\s*402\b/.test(message);
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

/**
 * Provider-side capacity shortage (Anthropic's 529 overloaded_error). Not a
 * key limit and not an operator fault: the SDK has already retried it with
 * backoff, so the right move is the next provider, with no cooldown — the
 * provider is usually back within seconds.
 */
export function isOverloadedError(error: unknown): boolean {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status: unknown }).status
      : undefined;
  if (status === 529) return true;
  const message = error instanceof Error ? error.message : "";
  return /^\s*529\b/.test(message) || message.includes("overloaded_error");
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
  // The OpenAI SDK's timeout carries no code or cause, only this name.
  if (error instanceof Error && error.name === "APIConnectionTimeoutError") return true;
  const code =
    typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  if (/^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|UND_ERR)/.test(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (!message) return false;
  if (
    /econnrefused|econnreset|enotfound|etimedout|ehostunreach|fetch failed|connection error|socket hang up|request timed out/.test(
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
 * model SKU was retired, the caller misspelled an id, or no provider on that
 * platform serves it. The
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
  // message to mention a model/endpoint.
  const isStatus404 = status === 404 || /^\s*404\b/.test(message);
  if (isStatus404 && (message.includes("endpoint") || message.includes("model"))) {
    return true;
  }

  return false;
}

/** USD per MILLION tokens (input = prompt, output = completion). */
interface ModelRateUsdPerMTok {
  input: number;
  output: number;
  /**
   * Prompt-cache pricing, as a multiple of `input`. Only rows whose provider
   * reports cache reads AND writes distinctly carry it (Anthropic); without it
   * cached tokens are billed as ordinary input — the conservative historical
   * behaviour for providers whose cache discount we don't model.
   */
  cacheRead?: number;
  /**
   * Long-context tier: a request whose prompt (ALL input tokens, cache reads
   * and writes included) exceeds `aboveTokens` pays these rates instead.
   */
  longContext?: { aboveTokens: number; input: number; output: number };
}

/** Anthropic cache-write multipliers of base input (same for every model). */
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;

/** Read from cache = 10% of base input on most Claude models. */
const CLAUDE_CACHE_READ = 0.1;

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
  // Qwen (the local openai-compat default family, qwen3:8b): list price read
  // 2026-08-10, rounded up. Without this row qwen matched nothing and took the
  // sonnet-tier default ($3/$15 vs $0.03/$0.13) — over-billing is "safe" for a
  // protective cap in isolation, but ~100x too fast burns the daily caps and
  // the fleet stops classifying mid-day. Specific rows MUST stay above generic.
  { match: ["qwen"], rate: { input: 0.1, output: 0.3 } },
  // Gemini flash-lite spans 2.5 ($0.10/$0.40) and 3.1 ($0.25/$1.50); the
  // family row must carry the HIGHER of the two or the newer SKU under-bills.
  { match: ["gemini", "flash-lite"], rate: { input: 0.25, output: 1.5 } },
  { match: ["gemini", "flash"], rate: { input: 0.3, output: 2.5 } },
  { match: ["gemini", "pro"], rate: { input: 1.25, output: 10 } },
  { match: ["gemma"], rate: { input: 0.1, output: 0.4 } },
  // Claude: Anthropic list prices read 2026-10-24
  // (platform.claude.com/docs/en/about-claude/pricing). Ids are matched with
  // dots folded to dashes, so the native `claude-haiku-5-5` and the
  // vendor-prefixed `anthropic/claude-haiku-5.5` hit the same row. Specific
  // SKUs above their family rows; the family rows keep the HIGHEST price in
  // the family.
  {
    match: ["claude", "haiku-5-5"],
    rate: {
      input: 0.1,
      output: 0.5,
      cacheRead: CLAUDE_CACHE_READ,
      longContext: { aboveTokens: 100_000, input: 0.5, output: 2.5 },
    },
  },
  { match: ["claude", "haiku"], rate: { input: 1, output: 5, cacheRead: CLAUDE_CACHE_READ } },
  { match: ["claude", "sonnet-5-5"], rate: { input: 2, output: 10, cacheRead: 0.05 } },
  // Sonnet 5 ($2/$10) and Opus 4.5–5 ($5/$25), same 2026-10-24 list-price
  // read. They used to ride their (higher) family rows while they were served
  // through the retired proxy lane; on the native Claude API they bill at list
  // price. Cache reads keep the family's 10% (no distinct rate recorded).
  { match: ["claude", "sonnet-5"], rate: { input: 2, output: 10, cacheRead: CLAUDE_CACHE_READ } },
  { match: ["claude", "sonnet"], rate: { input: 3, output: 15, cacheRead: CLAUDE_CACHE_READ } },
  { match: ["claude", "opus-5-5"], rate: { input: 4, output: 20, cacheRead: 0.05 } },
  { match: ["claude", "opus-5"], rate: { input: 5, output: 25, cacheRead: CLAUDE_CACHE_READ } },
  { match: ["claude", "opus-4-8"], rate: { input: 5, output: 25, cacheRead: CLAUDE_CACHE_READ } },
  { match: ["claude", "opus-4-7"], rate: { input: 5, output: 25, cacheRead: CLAUDE_CACHE_READ } },
  { match: ["claude", "opus-4-6"], rate: { input: 5, output: 25, cacheRead: CLAUDE_CACHE_READ } },
  { match: ["claude", "opus-4-5"], rate: { input: 5, output: 25, cacheRead: CLAUDE_CACHE_READ } },
  { match: ["claude", "opus"], rate: { input: 15, output: 75, cacheRead: CLAUDE_CACHE_READ } },
  { match: ["claude", "fable"], rate: { input: 10, output: 50, cacheRead: CLAUDE_CACHE_READ } },
  { match: ["claude", "mythos"], rate: { input: 10, output: 50, cacheRead: CLAUDE_CACHE_READ } },
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

/**
 * Resolve the per-M-token USD rate for a model id (family-prefix match).
 * Dots are folded to dashes first so a version written either way
 * (`haiku-5.5` / `haiku-5-5`) matches the same row.
 */
export function resolveModelRateUsdPerMTok(model: string): ModelRateUsdPerMTok {
  const id = model.toLowerCase().replace(/\./g, "-");
  const hit = MODEL_RATES.find((entry) => entry.match.every((needle) => id.includes(needle)));
  return hit?.rate ?? DEFAULT_MODEL_RATE;
}

const TOKENS_PER_M = 1_000_000;

/** Prompt-cache breakdown of a call's prompt tokens (all optional). */
export interface PromptCacheUsage {
  /** Prompt tokens served from cache. */
  readTokens?: number | null;
  /** Prompt tokens written to cache (all TTLs). */
  writeTokens?: number | null;
  /** Of `writeTokens`, those written with the 1-hour TTL. */
  write1hTokens?: number | null;
}

/** The cache breakdown of an OpenAI-shape `usage` block ({} when absent). */
export function promptCacheUsageOf(
  usage:
    | {
        prompt_tokens_details?: {
          cached_tokens?: number | null;
          cache_write_tokens?: number | null;
          cache_write_1h_tokens?: number | null;
        } | null;
      }
    | null
    | undefined,
): PromptCacheUsage {
  const details = usage?.prompt_tokens_details;
  if (!details) return {};
  return {
    readTokens: details.cached_tokens,
    writeTokens: details.cache_write_tokens,
    write1hTokens: details.cache_write_1h_tokens,
  };
}

function nonNegative(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Model-aware cost estimate feeding the token ledger, admin UI, and the
 * daily cost caps (via estimatePrebillCents / trueUpCostLedgers).
 *
 * `promptTokens` is the TOTAL prompt (OpenAI semantics: cache reads and writes
 * included). For rows that model prompt caching, the cache share is priced at
 * the read / write multipliers and only the remainder at base input; the cache
 * figures are clamped to the prompt total so a malformed usage block can never
 * price more tokens than were sent.
 */
export function estimateModelCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cache: PromptCacheUsage = {},
): number {
  const family = resolveModelRateUsdPerMTok(model);
  const prompt = nonNegative(promptTokens);
  const completion = nonNegative(completionTokens);
  const long = family.longContext;
  const rate = long && prompt > long.aboveTokens ? { ...family, ...long } : family;
  if (family.cacheRead === undefined) {
    return (prompt * rate.input + completion * rate.output) / TOKENS_PER_M;
  }
  const read = Math.min(nonNegative(cache.readTokens), prompt);
  const write = Math.min(nonNegative(cache.writeTokens), prompt - read);
  const write1h = Math.min(nonNegative(cache.write1hTokens), write);
  const uncached = prompt - read - write;
  const inputUsd =
    uncached * rate.input +
    read * rate.input * family.cacheRead +
    (write - write1h) * rate.input * CACHE_WRITE_5M_MULTIPLIER +
    write1h * rate.input * CACHE_WRITE_1H_MULTIPLIER;
  return (inputUsd + completion * rate.output) / TOKENS_PER_M;
}
