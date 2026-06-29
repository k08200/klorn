/**
 * LLM usage ledger — ground-truth token accounting.
 *
 * The cost gates (cost-guard.ts) PRE-BILL an estimated cost before every
 * call; until now the ACTUAL usage returned by providers was never recorded
 * anywhere, so real cost per call/user/day was unknowable and the estimates
 * could drift arbitrarily far from reality.
 *
 * This module writes one LlmUsageLog row per successful provider call. The
 * chokepoints are createCompletion / createVisionCompletion in openai.ts,
 * which pass the provider+model that ACTUALLY served the request after
 * failover (the loop may swap both), the real token counts, and the
 * pre-bill estimate so drift is measurable.
 *
 * Writes are fire-and-forget: a ledger failure must never fail or slow the
 * user-facing call. Cost-gate semantics are untouched — estimates still
 * gate; this table never gates anything.
 */

// NOTE: db.js (Prisma) is imported LAZILY inside the async functions below.
// openai.ts imports this module statically, and a static db.js import here
// would run Prisma's .env autoload BEFORE providers/index.js initializes —
// injecting real API keys into unit tests and flipping them from offline to
// live-LLM on any machine with a local .env. cents.ts exists for the same
// reason (usdToCents without the cost-guard → db.js chain).
import { usdToCents } from "./cents.js";
import { estimateModelCostUsd } from "./model-fallback.js";
import { captureError } from "./sentry.js";

export type LlmCallSource = "foreground" | "background";

/** Shape of the `usage` block on OpenAI-compatible non-streaming responses. */
export interface ProviderUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  /**
   * Cache-hit detail (OpenAI automatic prompt caching, Gemini implicit
   * caching via the gemini-native mapping, OpenRouter passthrough for
   * providers that report it). Absent = the provider doesn't cache or
   * doesn't say — recorded as 0, never estimated.
   */
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
}

export interface RecordLlmUsageInput {
  /** null = system-initiated call (no user accounting) */
  userId: string | null;
  /** Provider that actually served the request (post-failover) */
  provider: string;
  /** Model that actually served the request (post-failover) */
  model: string;
  source: LlmCallSource;
  /** What the pre-bill gate charged for this call, in USD cents */
  estimatedCostCents: number;
  /**
   * Raw usage from the provider response. Pass null/undefined when the
   * provider returned none (e.g. streaming) — the row is still recorded
   * with usageMissing=true so coverage gaps stay visible.
   */
  usage: ProviderUsage | null | undefined;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SUMMARY_DAYS = 7;

/**
 * Nominal token counts for the pre-bill floor. The old pre-bill called
 * estimateModelCostUsd(model, 0, 0), which is token-linear and therefore
 * ALWAYS 0¢ — the daily caps never accumulated through the gate at all
 * (found while building this ledger). A typical classification/chat call
 * runs ~2k prompt / ~0.5k completion tokens; pre-billing that floor makes
 * a runaway loop of paid-model calls trip the cap, and the post-call
 * true-up (trueUpCostLedgers) settles the difference against actuals.
 * Free models still estimate to 0¢ regardless of token counts.
 */
const PREBILL_NOMINAL_PROMPT_TOKENS = 2000;
const PREBILL_NOMINAL_COMPLETION_TOKENS = 500;

/**
 * Pre-bill estimate for `model` — the single source of truth used both by
 * enforceCostGates() in openai.ts (what the gate charges) and by the ledger
 * row (what we record), so the two can never diverge.
 */
export function estimatePrebillCents(model: string): number {
  return usdToCents(
    estimateModelCostUsd(model, PREBILL_NOMINAL_PROMPT_TOKENS, PREBILL_NOMINAL_COMPLETION_TOKENS),
  );
}

/**
 * Post-call settlement: once a response carries real token counts, charge
 * the cost ledgers the difference between the actual model cost and what
 * the gate pre-billed. Only positive deltas are charged — the ledgers are
 * a protective cap, so when the pre-bill overshot we deliberately keep the
 * conservative (higher) figure rather than refunding.
 *
 * BYOK: when `servedByUserKey` is set, the call ran on the user's OWN provider
 * key — Klorn spent nothing, so neither the per-user cap nor the shared global
 * ceiling is charged. The gate already skipped the pre-bill for these (so
 * `prebilledCents` is 0); a genuine env-key fallthrough has servedByUserKey
 * false and is charged the full actual cost here.
 *
 * Never throws; failures are captured and swallowed (same contract as
 * recordLlmUsage).
 */
export async function trueUpCostLedgers(input: {
  userId: string | null;
  model: string;
  prebilledCents: number;
  usage: ProviderUsage | null | undefined;
  servedByUserKey?: boolean;
}): Promise<void> {
  try {
    // Served on the user's own key → Klorn's ledgers stay untouched.
    if (input.servedByUserKey) return;
    const promptTokens = input.usage?.prompt_tokens ?? null;
    const completionTokens = input.usage?.completion_tokens ?? null;
    if (promptTokens == null && completionTokens == null) return;

    const actualCents = usdToCents(
      estimateModelCostUsd(input.model, promptTokens ?? 0, completionTokens ?? 0),
    );
    const deltaCents = actualCents - Math.max(0, Math.round(input.prebilledCents));
    if (deltaCents <= 0) return;

    const { recordCostUsage, recordGlobalCostUsage } = await import("./cost-guard.js");
    if (input.userId) {
      // Await so the atomic delta lands (and this try/catch owns any failure).
      // The call already completed, so an over-cap true-up can't be gated here
      // (you can't un-spend); surface it for observability — the next pre-bill's
      // checkCostGate is what actually blocks further calls.
      const usage = await recordCostUsage(input.userId, deltaCents, input.model);
      if (usage?.overCap) {
        console.warn(
          `[llm-usage] true-up pushed user ${input.userId} past the daily cost cap (now ${usage.totalCents}¢)`,
        );
      }
    }
    recordGlobalCostUsage(deltaCents);
  } catch (err) {
    // Fire-and-forget settlement: a failure here silently drops a real charge
    // (env-fallthrough cost that should land on the cap/ceiling), so signal it
    // — captureError alone is invisible without a Sentry DSN.
    console.warn("[llm-usage] cost true-up failed (model in Sentry extra)", err);
    captureError(err, {
      tags: { component: "llm-usage" },
      extra: { model: input.model, phase: "true-up" },
    });
  }
}

/**
 * Record one successful LLM call to the ground-truth ledger.
 *
 * NEVER throws and never blocks the caller meaningfully — callers invoke it
 * as `void recordLlmUsage(...)`. Failures are captured to Sentry and
 * swallowed.
 */
export async function recordLlmUsage(input: RecordLlmUsageInput): Promise<void> {
  try {
    const usage = input.usage ?? null;
    const usageMissing =
      usage === null ||
      (usage.prompt_tokens == null &&
        usage.completion_tokens == null &&
        usage.total_tokens == null);
    const promptTokens = usage?.prompt_tokens ?? 0;
    const cachedPromptTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const completionTokens = usage?.completion_tokens ?? 0;
    const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;

    const { prisma } = await import("./db.js");
    await prisma.llmUsageLog.create({
      data: {
        userId: input.userId,
        provider: input.provider,
        model: input.model,
        source: input.source,
        estimatedCostCents: Math.max(0, Math.round(input.estimatedCostCents)),
        promptTokens,
        cachedPromptTokens,
        completionTokens,
        totalTokens,
        usageMissing,
      },
    });
  } catch (err) {
    // Ground-truth usage ledger write failed — signal before the silent
    // captureError so a broken ledger is visible without a Sentry DSN.
    console.warn("[llm-usage] usage-ledger write failed (provider/model in Sentry extra)", err);
    captureError(err, {
      tags: { component: "llm-usage" },
      extra: { provider: input.provider, model: input.model, source: input.source },
    });
  }
}

export interface UsageSummaryBucket {
  calls: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostCents: number;
}

export interface UsageSummary {
  sinceDays: number;
  since: string;
  userId: string | null;
  /** cacheHitRate = cachedPromptTokens / promptTokens (0 when no prompts). */
  totals: UsageSummaryBucket & { usageMissingCalls: number; cacheHitRate: number };
  byModel: Array<UsageSummaryBucket & { provider: string; model: string }>;
}

const USAGE_SUMS = {
  promptTokens: true,
  cachedPromptTokens: true,
  completionTokens: true,
  totalTokens: true,
  estimatedCostCents: true,
} as const;

/**
 * Founder-facing read API: totals + per-model breakdown over the last
 * `sinceDays` days, optionally scoped to one user. Pure Prisma aggregation —
 * no in-memory scans.
 */
export async function getUsageSummary(
  userId?: string,
  sinceDays: number = DEFAULT_SUMMARY_DAYS,
): Promise<UsageSummary> {
  const days = Number.isFinite(sinceDays) && sinceDays > 0 ? sinceDays : DEFAULT_SUMMARY_DAYS;
  const since = new Date(Date.now() - days * DAY_MS);
  const where = {
    createdAt: { gte: since },
    ...(userId ? { userId } : {}),
  };

  const { prisma } = await import("./db.js");
  const [totals, byModel, usageMissingCalls] = await Promise.all([
    prisma.llmUsageLog.aggregate({
      where,
      _count: { _all: true },
      _sum: USAGE_SUMS,
    }),
    prisma.llmUsageLog.groupBy({
      by: ["provider", "model"],
      where,
      _count: { _all: true },
      _sum: USAGE_SUMS,
      orderBy: { _sum: { totalTokens: "desc" } },
    }),
    prisma.llmUsageLog.count({ where: { ...where, usageMissing: true } }),
  ]);

  const promptTokens = totals._sum.promptTokens ?? 0;
  const cachedPromptTokens = totals._sum.cachedPromptTokens ?? 0;

  return {
    sinceDays: days,
    since: since.toISOString(),
    userId: userId ?? null,
    totals: {
      calls: totals._count._all,
      promptTokens,
      cachedPromptTokens,
      completionTokens: totals._sum.completionTokens ?? 0,
      totalTokens: totals._sum.totalTokens ?? 0,
      estimatedCostCents: totals._sum.estimatedCostCents ?? 0,
      usageMissingCalls,
      cacheHitRate: promptTokens === 0 ? 0 : Number((cachedPromptTokens / promptTokens).toFixed(4)),
    },
    byModel: byModel.map((row) => ({
      provider: row.provider,
      model: row.model,
      calls: row._count._all,
      promptTokens: row._sum.promptTokens ?? 0,
      cachedPromptTokens: row._sum.cachedPromptTokens ?? 0,
      completionTokens: row._sum.completionTokens ?? 0,
      totalTokens: row._sum.totalTokens ?? 0,
      estimatedCostCents: row._sum.estimatedCostCents ?? 0,
    })),
  };
}
