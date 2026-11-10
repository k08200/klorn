/**
 * The deterministic front of the judge, shared by the v2 and v3 benchmark
 * paths so the A/B compares ONLY the LLM stage. Mirrors the order in
 * `judgeEmail` (poc-judge.ts): the user's pin → clear-marketing fast-path →
 * sender prior (same guards, `canShortCircuit`) → learned rule.
 *
 * Doc §3(1)/§3(4) agrees: pins and overrides keep their precedence, and the
 * marketing fast-path is a deterministic pre-fact that wins when certain.
 */

import type { ClassifiableEmail } from "../judge/email-classifier.js";
import { isClearMarketing, looksUrgent } from "../judge/keyword-policy.js";
import { canShortCircuit, EMPTY_JUDGE_CONTEXT, type JudgeContext } from "../judge/poc-judge.js";
import type { Tier } from "../judge/tiers.js";
import { matchLearnedRules } from "../learning/learned-rules.js";

export type FrontSource = "pinned-rule" | "fast-path" | "sender-prior" | "learned-rule";

export interface FrontDecision {
  tier: Tier;
  source: FrontSource;
}

/**
 * Only the fields the deterministic front reads. Used for the v2 control run on
 * sets whose fixtures carry sender facts: without it, v2's prompt sees sender
 * history that v3's fact prompt does not, and the A/B is no longer LLM-stage only.
 */
export function frontOnlyContext(context: JudgeContext): JudgeContext {
  return {
    ...EMPTY_JUDGE_CONTEXT,
    senderPrior: context.senderPrior,
    pinnedTier: context.pinnedTier ?? null,
    learnedRules: context.learnedRules ?? [],
  };
}

export function deterministicFront(
  email: ClassifiableEmail,
  context: JudgeContext,
): FrontDecision | null {
  if (context.pinnedTier) return { tier: context.pinnedTier, source: "pinned-rule" };
  if (isClearMarketing(email)) return { tier: "SILENT", source: "fast-path" };
  const prior = context.senderPrior;
  if (prior && canShortCircuit(prior, email)) return { tier: prior.tier, source: "sender-prior" };
  const rule = matchLearnedRules(email, context.learnedRules ?? []);
  if (rule && (rule.tier === "PUSH" || !looksUrgent(email))) {
    return { tier: rule.tier, source: "learned-rule" };
  }
  return null;
}
