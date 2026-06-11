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

import { usdToCents } from "./cost-guard.js";
import { prisma } from "./db.js";
import { estimateModelCostUsd } from "./model-fallback.js";
import { captureError } from "./sentry.js";

export type LlmCallSource = "foreground" | "background";

/** Shape of the `usage` block on OpenAI-compatible non-streaming responses. */
export interface ProviderUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
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
 * Pre-bill estimate for `model`, computed exactly the way enforceCostGates()
 * in openai.ts charges the cost ledgers. Kept here so the recorded estimate
 * can never diverge from the gate's arithmetic.
 */
export function estimatePrebillCents(model: string): number {
  return usdToCents(estimateModelCostUsd(model, 0, 0));
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
    const completionTokens = usage?.completion_tokens ?? 0;
    const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;

    await prisma.llmUsageLog.create({
      data: {
        userId: input.userId,
        provider: input.provider,
        model: input.model,
        source: input.source,
        estimatedCostCents: Math.max(0, Math.round(input.estimatedCostCents)),
        promptTokens,
        completionTokens,
        totalTokens,
        usageMissing,
      },
    });
  } catch (err) {
    captureError(err, {
      tags: { component: "llm-usage" },
      extra: { provider: input.provider, model: input.model, source: input.source },
    });
  }
}

export interface UsageSummaryBucket {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostCents: number;
}

export interface UsageSummary {
  sinceDays: number;
  since: string;
  userId: string | null;
  totals: UsageSummaryBucket & { usageMissingCalls: number };
  byModel: Array<UsageSummaryBucket & { provider: string; model: string }>;
}

const USAGE_SUMS = {
  promptTokens: true,
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

  return {
    sinceDays: days,
    since: since.toISOString(),
    userId: userId ?? null,
    totals: {
      calls: totals._count._all,
      promptTokens: totals._sum.promptTokens ?? 0,
      completionTokens: totals._sum.completionTokens ?? 0,
      totalTokens: totals._sum.totalTokens ?? 0,
      estimatedCostCents: totals._sum.estimatedCostCents ?? 0,
      usageMissingCalls,
    },
    byModel: byModel.map((row) => ({
      provider: row.provider,
      model: row.model,
      calls: row._count._all,
      promptTokens: row._sum.promptTokens ?? 0,
      completionTokens: row._sum.completionTokens ?? 0,
      totalTokens: row._sum.totalTokens ?? 0,
      estimatedCostCents: row._sum.estimatedCostCents ?? 0,
    })),
  };
}
