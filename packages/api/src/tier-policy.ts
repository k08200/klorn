/**
 * Tier-decision policy — SINGLE SOURCE OF TRUTH for how the 4 features map to
 * a tier.
 *
 * This is the deterministic core of the firewall: the LLM (poc-judge.ts) only
 * SCORES the four features; the *decision* — which tier those scores land on —
 * is made here, by a reviewable rule, not by the model. Centralising it does
 * three things:
 *   1. one editable surface for the feature schema (no more PocFeatures vs
 *      DecisionFeatures drift — both derive from `TierFeatures` here),
 *   2. every threshold is a named, documented constant instead of an inline
 *      magic number, so the rule can be read, tuned, and (later) calibrated
 *      from real override data without hunting through the judge,
 *   3. `tierFromFeatures` lives next to the thresholds it reads, so the policy
 *      is one file you can audit end to end.
 *
 * Behaviour is identical to the rule that previously lived in poc-judge.ts —
 * the thresholds below are the exact values tuned against the founder's
 * 50-email ground truth (2026-05-28) plus the senderTrust AUTO floor added
 * 2026-06-12. poc-judge.ts re-exports these for back-compat.
 */

import type { Tier } from "./tiers.js";

/**
 * The four 0.0–1.0 features that drive every tier decision. This is the
 * canonical feature schema: poc-judge's `PocFeatures` and decision-label's
 * `DecisionFeatures` are both aliases of this type so the vector can never
 * fork across the scorer, the rule, and the decision ledger.
 */
export interface TierFeatures {
  /** Model's own confidence that its other three scores are right. */
  confidence: number;
  /** 1.0 = sender is a known, important human; 0.0 = unknown / promotional. */
  senderTrust: number;
  /** 1.0 = if AUTO is wrong it's trivial to undo; 0.0 = irreversible. */
  reversibility: number;
  /** 1.0 = needs attention within hours; 0.0 = informational, no clock. */
  urgency: number;
}

/**
 * Every threshold the tier rule reads, named and grouped by the branch that
 * uses it. Editing the policy = editing this object. These constants are the
 * surface a future calibration pass (tuned from accumulated overrides) will
 * adjust — keep them data, not inline literals.
 */
export const TIER_THRESHOLDS = {
  /** Branch 1: below this confidence, hide nothing — queue for review. */
  lowConfidenceFloor: 0.5,
  /** Branch 2: urgent AND confident → interrupt. */
  push: { urgency: 0.7, confidence: 0.7 },
  /** Branch 3: clear promotional — anonymous, no clock, trivially reversible. */
  silent: { senderTrust: 0.2, urgency: 0.2, reversibility: 0.9 },
  /** Branch 4: safe to auto-handle — reversible, sure, not urgent, trusted. */
  auto: { reversibility: 0.85, confidence: 0.85, urgency: 0.5, senderTrust: 0.5 },
} as const;

/**
 * Mutable structural shape of {@link TIER_THRESHOLDS}. The runtime
 * effective-threshold config (base const merged with approved overrides, see
 * ontology-overrides.ts) has this shape but not the literal `as const` types, so
 * `tierFromFeatures` takes a `ThresholdConfig` rather than `typeof TIER_THRESHOLDS`.
 */
export interface ThresholdConfig {
  lowConfidenceFloor: number;
  push: { urgency: number; confidence: number };
  silent: { senderTrust: number; urgency: number; reversibility: number };
  auto: { reversibility: number; confidence: number; urgency: number; senderTrust: number };
}

/** Clamp a feature score into the valid 0.0–1.0 range. Shared by the judge. */
export const CLAMP = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * Deterministic 4-feature → 4-tier mapping.
 *
 * Re-tuned 2026-05-28 after the first 50-email accuracy run: QUEUE is the
 * default ("things I'll look at on my own schedule"), and SILENT is narrow
 * ("clear marketing/promo I never want to see").
 *
 * Order matters — earlier branches dominate.
 */
export function tierFromFeatures(
  features: TierFeatures,
  thresholds: ThresholdConfig = TIER_THRESHOLDS,
): {
  tier: Tier;
  reason: string;
} {
  const f: TierFeatures = {
    confidence: CLAMP(features.confidence),
    senderTrust: CLAMP(features.senderTrust),
    reversibility: CLAMP(features.reversibility),
    urgency: CLAMP(features.urgency),
  };
  const t = thresholds;

  // 1. Very low confidence → QUEUE.
  //    Hiding uncertain mail behind a wrong tier is the worst failure mode.
  if (f.confidence < t.lowConfidenceFloor) {
    return { tier: "QUEUE", reason: "Low classification confidence — queued for review" };
  }

  // 2. Urgent + sure → wake the user.
  if (f.urgency >= t.push.urgency && f.confidence >= t.push.confidence) {
    return { tier: "PUSH", reason: "Urgent and confident" };
  }

  // 3. Clear promotional / marketing signal → SILENT.
  //    Very narrow: only when the sender is anonymous-ish AND there is no
  //    time signal AND any wrong action would be trivially reversible. This
  //    matches the founder's SILENT bucket (LinkedIn invites, 광고, view-in-browser).
  //    System notifications (Vercel deploy, account confirmations, own-product
  //    signups) do NOT match because they carry context worth a manual glance.
  if (
    f.senderTrust < t.silent.senderTrust &&
    f.urgency < t.silent.urgency &&
    f.reversibility > t.silent.reversibility
  ) {
    return { tier: "SILENT", reason: "Promotional / marketing — no human attention needed" };
  }

  // 4. Trivially reversible + very sure + not urgent + trusted → AUTO.
  //    Floors stay high so we never auto-handle a destructive action or a
  //    misclassification. The senderTrust floor was added 2026-06-12: precise
  //    models score routine system notices (invoices, bills, deploy alerts)
  //    conf=1.0/rev=1.0 and auto-claimed them — mail from a sender with no
  //    trust signal must never be auto-handled. Per POC.md OUT scope, AUTO is
  //    *classified only* during the POC; actual execution stays disabled.
  if (
    f.reversibility >= t.auto.reversibility &&
    f.confidence >= t.auto.confidence &&
    f.urgency < t.auto.urgency &&
    f.senderTrust >= t.auto.senderTrust
  ) {
    return { tier: "AUTO", reason: "Reversible, confident, not urgent" };
  }

  // 5. Default → QUEUE.
  //    Everything that isn't clearly marketing, urgent, or auto-handleable
  //    belongs in the manual review queue. The founder's mental model treats
  //    "I'll look at this on my own pace" as the dominant bucket.
  return { tier: "QUEUE", reason: "Visible in queue for manual review" };
}
