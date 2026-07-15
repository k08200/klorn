/**
 * Ontology — the single public surface for Klorn's deterministic core.
 *
 * The "brain" is four policy modules: the feature→tier rule (tier-policy), the
 * sender-knowledge schema + prior thresholds (sender-policy), the no-LLM
 * pattern vocabulary (keyword-policy), and the model-routing dial (judge-dial).
 * This module re-exports all of them so a consumer — the firewall, an admin
 * view, the desktop shell, or a second app — imports ONE thing instead of
 * reaching into four files.
 *
 * `describePolicy()` is the read side of the shared ontology: a plain,
 * JSON-serializable snapshot of everything the brain currently believes. It is
 * what a second surface queries to inspect (and, later, write back to) the same
 * knowledge the classifier runs on — the seam the cross-app shared layer grows
 * from.
 */

export * from "../judge/judge-dial.js";
export * from "../judge/keyword-policy.js";
export * from "../judge/tier-policy.js";
export * from "./sender-policy.js";

import { ESCALATION_CONFIDENCE_FLOOR, escalationModel } from "../judge/judge-dial.js";
import { KEYWORD_SCORES } from "../judge/keyword-policy.js";
import { TIER_THRESHOLDS } from "../judge/tier-policy.js";
import { TIERS } from "../judge/tiers.js";
import { getEffectiveThresholds, overriddenKnobs } from "./ontology-overrides.js";
import { PRIOR_SHORTCIRCUIT_TIERS, SENDER_PRIOR_POLICY } from "./sender-policy.js";

/**
 * A JSON-serializable snapshot of the whole deterministic core. Sets are
 * rendered as arrays; the live escalation model reflects current env.
 *
 * Every nested policy object is deep-copied so the snapshot is a fully detached
 * read: a consumer that mutates the returned object (the inspector receives it
 * as `unknown` over IPC and could) cannot corrupt the live module constants the
 * classifier runs on. (`as const` is compile-time only — it does not freeze the
 * objects at runtime, so a shallow `{ ...TIER_THRESHOLDS }` would still share
 * the nested push/silent/auto references.)
 */
export function describePolicy() {
  const effective = getEffectiveThresholds();
  return {
    tiers: [...TIERS],
    relation: {
      // `thresholds` is the git-const base; `effective` is what the classifier
      // actually runs on right now (base + approved overrides); `overriddenKnobs`
      // names the diff. With no approvals these are identical.
      thresholds: {
        lowConfidenceFloor: TIER_THRESHOLDS.lowConfidenceFloor,
        push: { ...TIER_THRESHOLDS.push },
        silent: { ...TIER_THRESHOLDS.silent },
        auto: { ...TIER_THRESHOLDS.auto },
      },
      effective: {
        lowConfidenceFloor: effective.lowConfidenceFloor,
        push: { ...effective.push },
        silent: { ...effective.silent },
        auto: { ...effective.auto },
      },
      overriddenKnobs: overriddenKnobs(),
    },
    entity: {
      priorThresholds: { ...SENDER_PRIOR_POLICY },
      shortCircuitTiers: {
        override: [...PRIOR_SHORTCIRCUIT_TIERS.override],
        history: [...PRIOR_SHORTCIRCUIT_TIERS.history],
      },
    },
    pattern: {
      keywordScores: {
        senderTrust: { ...KEYWORD_SCORES.senderTrust },
        urgency: { ...KEYWORD_SCORES.urgency },
        reversibility: { ...KEYWORD_SCORES.reversibility },
        confidence: { ...KEYWORD_SCORES.confidence },
      },
    },
    dial: {
      escalationConfidenceFloor: ESCALATION_CONFIDENCE_FLOOR,
      // null when the dial is off (JUDGE_ESCALATION_MODEL unset).
      escalationModel: escalationModel(),
    },
  };
}

export type PolicySnapshot = ReturnType<typeof describePolicy>;
