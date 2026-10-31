/**
 * Per-item runners for the P1 benchmark. Both paths share the deterministic
 * front (front.ts); they differ only in the LLM stage:
 *  - v2: the production judge, unchanged (`judgeEmail` with a model override),
 *    i.e. 4 calibrated scores → tierFromFeaturesV2 → floors.
 *  - v3: facts schema v1 with verified evidence → policy.ts.
 */
import type { ClassifiableEmail } from "../judge/email-classifier.js";
import { hasSpamLabel, type JudgeContext, judgeEmail } from "../judge/poc-judge.js";
import type { TierFeatures } from "../judge/tier-policy.js";
import type { Tier } from "../judge/tiers.js";
import { extractFacts } from "./extract.js";
import type { FactsV1 } from "./facts-schema.js";
import { deterministicFront } from "./front.js";
import type { BenchRow } from "./metrics.js";
import { laneFromFacts } from "./policy.js";

export interface EvalItem {
  id: string;
  from: string;
  subject: string;
  snippet: string | null;
  body?: string | null;
  labels: string[];
  receivedAt: string;
  /** The label in effect for this run (labelV2 when the v2 ontology is on). */
  truth: Tier;
}

export interface ItemResult extends BenchRow {
  features?: TierFeatures;
  reason?: string;
  facts?: FactsV1 | null;
  rawFacts?: FactsV1 | null;
  issues?: string[];
}

const toEmail = (item: EvalItem): ClassifiableEmail => ({
  id: item.id,
  from: item.from,
  subject: item.subject,
  snippet: item.snippet,
  body: item.body ?? null,
  labels: item.labels,
});

export async function judgeItemV2(
  item: EvalItem,
  context: JudgeContext,
  model: string,
): Promise<ItemResult> {
  const j = await judgeEmail(toEmail(item), undefined, context, undefined, model);
  return {
    id: item.id,
    truth: item.truth,
    predicted: j.tier,
    source: j.source ?? "llm",
    features: j.features,
    reason: j.reason,
  };
}

export async function judgeItemV3(
  item: EvalItem,
  context: JudgeContext,
  model: string,
  includeBody: boolean,
): Promise<ItemResult> {
  const email = toEmail(item);
  const base = { id: item.id, truth: item.truth };
  const front = deterministicFront(email, context);
  if (front) return { ...base, predicted: front.tier, source: front.source };

  const extraction = await extractFacts(
    { ...email, receivedAt: item.receivedAt },
    model,
    includeBody,
  );
  if (extraction.providerFailed) {
    return {
      ...base,
      predicted: "QUEUE",
      source: "v3-provider-failed",
      issues: [extraction.error ?? ""],
    };
  }
  if (!extraction.facts) {
    return { ...base, predicted: "QUEUE", source: "v3-unparsed", issues: extraction.issues };
  }
  const decision = laneFromFacts(extraction.facts, {
    receivedAt: new Date(item.receivedAt),
    spam: hasSpamLabel(item.labels),
  });
  return {
    ...base,
    predicted: decision.lane,
    source: "v3",
    rule: decision.rule,
    facts: extraction.facts,
    rawFacts: extraction.rawFacts,
    evidenceTotal: extraction.evidenceTotal,
    evidenceValid: extraction.evidenceValid,
    dueUnbound: extraction.dueUnbound,
    ambiguous: extraction.facts.ambiguous,
    issues: extraction.issues,
  };
}

/** Bounded-concurrency map that keeps input order, with an optional pause between items. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  delayMs: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
      if (delayMs > 0 && cursor < items.length) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker),
  );
  return results;
}
