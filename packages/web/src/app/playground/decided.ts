/**
 * Which of the four scores "decided the lane", read from the server's
 * `decidedBy` (the tier-policy.ts rule that actually fired — see
 * packages/api/src/judge/tier-policy.ts tierFromFeaturesV2 and poc-judge.ts
 * decidedByOf). Nothing is re-derived from thresholds here, so the marker
 * cannot drift from the real rules.
 *
 *   urgent          PUSH    urgency ≥ 0.7 AND confidence ≥ 0.7
 *   low-confidence  QUEUE   confidence below the floor
 *   promotional     SILENT  low sender trust AND low urgency AND easy to undo
 *   scheduling      MEETING content rule, before any score  → a sentence
 *   transactional   INFO    content rule + calm urgency     → a sentence
 *   default         QUEUE   nothing stronger fired          → a sentence
 *   marketing       SILENT  fast-path, before any score     → a sentence
 *   automated-sender        a floor overrode the scored lane → a sentence
 */

export type FeatureKey = "urgency" | "senderTrust" | "reversibility" | "confidence";

export const FEATURE_ORDER: readonly FeatureKey[] = [
  "urgency",
  "senderTrust",
  "reversibility",
  "confidence",
];

export type DecidedBy =
  | "scheduling"
  | "low-confidence"
  | "urgent"
  | "promotional"
  | "transactional"
  | "default"
  | "marketing"
  | "automated-sender";

export interface DecidedExplanation {
  /** Scores drawn in the lane ink with "· decided the lane". */
  readonly drivers: readonly FeatureKey[];
  /** A sentence (i18n key) when a content rule, not a score, decided. */
  readonly noteKey: string | null;
}

const EXPLANATIONS: Record<DecidedBy, DecidedExplanation> = {
  urgent: { drivers: ["urgency", "confidence"], noteKey: null },
  "low-confidence": { drivers: ["confidence"], noteKey: "playground.why.lowConfidence" },
  promotional: { drivers: ["senderTrust", "urgency", "reversibility"], noteKey: null },
  scheduling: { drivers: [], noteKey: "playground.why.scheduling" },
  transactional: { drivers: [], noteKey: "playground.why.transactional" },
  default: { drivers: [], noteKey: "playground.why.default" },
  marketing: { drivers: [], noteKey: "playground.why.marketing" },
  "automated-sender": { drivers: [], noteKey: "playground.why.automated" },
};

const NONE: DecidedExplanation = { drivers: [], noteKey: null };

/** Unknown or absent (v1 rule set, older API) → no marker, never a guess. */
export function explainDecision(decidedBy: unknown): DecidedExplanation {
  if (typeof decidedBy !== "string") return NONE;
  return Object.hasOwn(EXPLANATIONS, decidedBy) ? EXPLANATIONS[decidedBy as DecidedBy] : NONE;
}
