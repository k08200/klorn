/**
 * Calibration evidence for question (a): is v2 coupled to one model's
 * confidence calibration?
 *
 * Two instruments over the SAME v2 answers (no new LLM calls):
 *  1. `urgentCalibration` — on truth-PUSH items the LLM scored, how many
 *     misses cleared urgency but failed the confidence bar.
 *  2. `counterfactual` — re-run the shipped v2 rule (tierFromFeaturesV2 + the
 *     automated-sender PUSH floor + CI-noise + spam floors, as in judgeEmail)
 *     with the confidence bar moved. Recall gained vs false PUSH added.
 */
import { detectCiNoise, isCiNoiseSilentEnabled } from "../judge/ci-noise.js";
import type { ClassifiableEmail } from "../judge/email-classifier.js";
import {
  detectSchedulingIntent,
  detectTransactionalNotice,
  isAutomatedSender,
} from "../judge/keyword-policy.js";
import { applySpamFloor } from "../judge/poc-judge.js";
import {
  type ThresholdConfig,
  TIER_THRESHOLDS,
  type TierFeatures,
  tierFromFeaturesV2,
} from "../judge/tier-policy.js";
import type { Tier } from "../judge/tiers.js";

export interface V2ScoredRow {
  email: ClassifiableEmail;
  truth: Tier;
  predicted: Tier;
  /** judgeEmail's source: only "llm" rows carry model features. */
  source: string;
  features: TierFeatures;
}

export interface ThresholdVariant {
  name: string;
  thresholds: ThresholdConfig;
}

export const CONFIDENCE_VARIANTS: readonly ThresholdVariant[] = [
  { name: "shipped (conf ≥ 0.70)", thresholds: TIER_THRESHOLDS },
  {
    name: "conf ≥ 0.50",
    thresholds: { ...TIER_THRESHOLDS, push: { ...TIER_THRESHOLDS.push, confidence: 0.5 } },
  },
  {
    name: "confidence ignored",
    thresholds: {
      ...TIER_THRESHOLDS,
      lowConfidenceFloor: 0,
      push: { ...TIER_THRESHOLDS.push, confidence: 0 },
    },
  },
];

/** The v2 scoring path of judgeEmail after feature extraction, with swappable thresholds. */
export function v2TierAt(
  email: ClassifiableEmail,
  features: TierFeatures,
  thresholds: ThresholdConfig,
): Tier {
  const decided = tierFromFeaturesV2(
    features,
    { scheduling: detectSchedulingIntent(email), transactional: detectTransactionalNotice(email) },
    thresholds,
  );
  if (detectCiNoise(email) && isCiNoiseSilentEnabled()) return "SILENT";
  const pushFloored =
    decided.tier === "PUSH" && isAutomatedSender(email.from ?? "") ? "QUEUE" : decided.tier;
  return applySpamFloor(email.labels, { tier: pushFloored, reason: "" }).tier;
}

export interface CounterfactualResult {
  variant: string;
  correct: number;
  n: number;
  pushHit: number;
  pushTruth: number;
  /** Items predicted PUSH that are not truth-PUSH. */
  falsePush: number;
  silentPredicted: number;
  silentCorrect: number;
  /** LLM rows whose recomputed tier differs from judgeEmail's (only meaningful for "shipped"). */
  recomputeMismatches: number;
}

export function counterfactual(
  rows: readonly V2ScoredRow[],
  variant: ThresholdVariant,
): CounterfactualResult {
  let recomputeMismatches = 0;
  const predicted = rows.map((r) => {
    if (r.source !== "llm") return r.predicted;
    const tier = v2TierAt(r.email, r.features, variant.thresholds);
    if (tier !== r.predicted) recomputeMismatches++;
    return tier;
  });
  const pairs = rows.map((r, i) => ({ truth: r.truth, predicted: predicted[i] }));
  return {
    variant: variant.name,
    correct: pairs.filter((p) => p.truth === p.predicted).length,
    n: pairs.length,
    pushHit: pairs.filter((p) => p.truth === "PUSH" && p.predicted === "PUSH").length,
    pushTruth: pairs.filter((p) => p.truth === "PUSH").length,
    falsePush: pairs.filter((p) => p.truth !== "PUSH" && p.predicted === "PUSH").length,
    silentPredicted: pairs.filter((p) => p.predicted === "SILENT").length,
    silentCorrect: pairs.filter((p) => p.predicted === "SILENT" && p.truth === "SILENT").length,
    recomputeMismatches,
  };
}

export interface UrgentCalibration {
  urgentTotal: number;
  /** Truth-PUSH items decided by the LLM path (others were short-circuited). */
  viaLlm: number;
  confidences: number[];
  urgencies: number[];
  /** LLM-scored urgent items with confidence below the shipped PUSH bar. */
  belowConfidenceBar: number;
  /** Missed only because of the confidence bar: with confidence ignored the rule gives PUSH. */
  missConfidenceGated: number;
  missUrgencyLow: number;
  /** Cleared both bars but was moved by another rule (scheduling, floors). */
  missOther: number;
}

export function urgentCalibration(rows: readonly V2ScoredRow[]): UrgentCalibration {
  const bar = TIER_THRESHOLDS.push;
  const urgent = rows.filter((r) => r.truth === "PUSH");
  const viaLlm = urgent.filter((r) => r.source === "llm");
  const missed = viaLlm.filter((r) => r.predicted !== "PUSH");
  // Gated = the bar alone kept it out: ignoring confidence would make it PUSH.
  // A scheduling-rule MEETING or a floor demotion is "other", whatever its confidence.
  const ignored = CONFIDENCE_VARIANTS[CONFIDENCE_VARIANTS.length - 1].thresholds;
  const gated = missed.filter(
    (r) =>
      r.features.urgency >= bar.urgency &&
      r.features.confidence < bar.confidence &&
      v2TierAt(r.email, r.features, ignored) === "PUSH",
  );
  const low = missed.filter((r) => r.features.urgency < bar.urgency);
  return {
    urgentTotal: urgent.length,
    viaLlm: viaLlm.length,
    confidences: viaLlm.map((r) => r.features.confidence).sort((a, b) => a - b),
    urgencies: viaLlm.map((r) => r.features.urgency).sort((a, b) => a - b),
    belowConfidenceBar: viaLlm.filter((r) => r.features.confidence < bar.confidence).length,
    missConfidenceGated: gated.length,
    missUrgencyLow: low.length,
    missOther: missed.length - gated.length - low.length,
  };
}
