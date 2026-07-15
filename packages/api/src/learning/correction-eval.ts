/**
 * Correction eval — weekly counterfactual accuracy on real user overrides.
 *
 * Every manual tier override is a gold label from real traffic. The
 * committed synthetic eval set is the CI regression gate, but it is also
 * the thing prompts get tuned against; this eval is the held-out
 * complement BY CONSTRUCTION — never committed, never tuned against,
 * refreshed weekly by actual usage. Email content never leaves the DB;
 * only scores are stored (CalibrationSnapshot.payload.correctionEval).
 *
 * Counterfactual guard: each overridden email is re-judged with its OWN
 * correction hidden from the judge context (judge-context
 * excludeOwnCorrection), otherwise the few-shot pool contains the answer
 * sheet. Other corrections from the same sender and the sender prior stay
 * — they are part of the system being measured.
 *
 * Bias note: users only correct what the firewall got wrong or almost
 * wrong, so this set skews hard. The TREND is the signal, not the
 * absolute number.
 *
 * Cost guards: hard cap CORRECTION_EVAL_LIMIT, sequential with an
 * inter-call delay, requires an LLM provider key (a keyword-only run
 * would measure the fallback, not the system), and every call flows
 * through the usage chokepoint so tokens land in LlmUsageLog.
 */

import { prisma } from "../db.js";
import { buildJudgeContext } from "../judge/judge-context.js";
import { judgeEmail } from "../judge/poc-judge.js";
import { isTier, TIERS, type Tier } from "../judge/tiers.js";

export const CORRECTION_EVAL_LIMIT = 50;
const DEFAULT_INTER_CALL_DELAY_MS = 1000;

export interface CorrectionEvalTierStats {
  support: number;
  correct: number;
  recall: number;
  predicted: number;
  precision: number;
}

export interface CorrectionEvalPayload {
  ranAt: string;
  n: number;
  /** Counterfactual agreement with the user's final tier choices. */
  agreement: number;
  perTier: Record<Tier, CorrectionEvalTierStats>;
  /** Which judge path produced each prediction. */
  sourceMix: Record<string, number>;
}

interface EvalPair {
  expected: Tier;
  predicted: Tier;
  source: string;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

export function summarizeCorrectionEval(pairs: EvalPair[], now: Date): CorrectionEvalPayload {
  const perTier = {} as Record<Tier, CorrectionEvalTierStats>;
  for (const tier of TIERS) {
    const support = pairs.filter((p) => p.expected === tier);
    const correct = support.filter((p) => p.predicted === tier).length;
    const predicted = pairs.filter((p) => p.predicted === tier);
    const predictedTrue = predicted.filter((p) => p.expected === tier).length;
    perTier[tier] = {
      support: support.length,
      correct,
      recall: support.length === 0 ? 0 : round(correct / support.length),
      predicted: predicted.length,
      precision: predicted.length === 0 ? 0 : round(predictedTrue / predicted.length),
    };
  }

  const sourceMix: Record<string, number> = {};
  for (const pair of pairs) {
    sourceMix[pair.source] = (sourceMix[pair.source] ?? 0) + 1;
  }

  const agreed = pairs.filter((p) => p.expected === p.predicted).length;
  return {
    ranAt: now.toISOString(),
    n: pairs.length,
    agreement: pairs.length === 0 ? 0 : round(agreed / pairs.length),
    perTier,
    sourceMix,
  };
}

function hasLlmProviderKey(): boolean {
  return ["OPENROUTER_API_KEY", "GEMINI_API_KEY", "OPENAI_COMPAT_BASE_URL"].some((key) =>
    Boolean(process.env[key]?.trim()),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface OverrideRow {
  sourceId: string;
  tier: string | null;
}

interface EmailRow {
  id: string;
  from: string;
  subject: string;
  snippet: string | null;
  labels: string[];
}

/**
 * Run the counterfactual eval over the user's most recent manual
 * overrides. Returns null when there is nothing meaningful to measure
 * (no provider key, no corrections, no surviving email rows).
 */
export async function runCorrectionEval(
  userId: string,
  now: Date = new Date(),
  opts: { delayMs?: number } = {},
): Promise<CorrectionEvalPayload | null> {
  if (!hasLlmProviderKey()) {
    console.log("[CORRECTION-EVAL] Skipped — no LLM provider configured");
    return null;
  }
  const delayMs = opts.delayMs ?? DEFAULT_INTER_CALL_DELAY_MS;

  const overrides = (await (
    prisma.attentionItem as unknown as {
      findMany: (args: unknown) => Promise<OverrideRow[]>;
    }
  ).findMany({
    where: {
      userId,
      source: "EMAIL",
      isManualOverride: true,
      tier: { not: null },
    },
    orderBy: { updatedAt: "desc" },
    take: CORRECTION_EVAL_LIMIT,
    select: { sourceId: true, tier: true },
  })) as OverrideRow[];

  const labelled = overrides.filter((o): o is OverrideRow & { tier: Tier } => isTier(o.tier));
  if (labelled.length === 0) return null;

  const emails = (await prisma.emailMessage.findMany({
    where: { id: { in: labelled.map((o) => o.sourceId) } },
    select: { id: true, from: true, subject: true, snippet: true, labels: true },
  })) as EmailRow[];
  const emailsById = new Map(emails.map((e) => [e.id, e]));

  const pairs: EvalPair[] = [];
  for (const override of labelled) {
    const email = emailsById.get(override.sourceId);
    if (!email) continue;

    const context = await buildJudgeContext(userId, {
      from: email.from,
      excludeEmailId: email.id,
      excludeOwnCorrection: true,
    });
    const judgement = await judgeEmail(
      { from: email.from, subject: email.subject, snippet: email.snippet, labels: email.labels },
      userId,
      context,
    );
    pairs.push({ expected: override.tier, predicted: judgement.tier, source: judgement.source });

    if (delayMs > 0 && pairs.length < labelled.length) await sleep(delayMs);
  }

  if (pairs.length === 0) return null;
  const payload = summarizeCorrectionEval(pairs, now);
  console.log(
    `[CORRECTION-EVAL] ${userId}: n=${payload.n} agreement=${payload.agreement} pushRecall=${payload.perTier.PUSH.recall}`,
  );
  return payload;
}
