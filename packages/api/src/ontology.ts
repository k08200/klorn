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

export * from "./judge-dial.js";
export * from "./keyword-policy.js";
export * from "./sender-policy.js";
export * from "./tier-policy.js";

import { ESCALATION_CONFIDENCE_FLOOR, escalationModel } from "./judge-dial.js";
import { KEYWORD_SCORES } from "./keyword-policy.js";
import { PRIOR_SHORTCIRCUIT_TIERS, SENDER_PRIOR_POLICY } from "./sender-policy.js";
import { TIER_THRESHOLDS } from "./tier-policy.js";
import { TIERS } from "./tiers.js";

/**
 * A JSON-serializable snapshot of the whole deterministic core. Sets are
 * rendered as arrays; the live escalation model reflects current env.
 *
 * Every policy object is shallow-copied so the snapshot is a detached read: a
 * consumer that mutates the returned object cannot corrupt the live module
 * constants the classifier runs on. (`as const` is compile-time only — it does
 * not freeze the objects at runtime.)
 */
export function describePolicy() {
  return {
    tiers: [...TIERS],
    relation: { thresholds: { ...TIER_THRESHOLDS } },
    entity: {
      priorThresholds: { ...SENDER_PRIOR_POLICY },
      shortCircuitTiers: {
        override: [...PRIOR_SHORTCIRCUIT_TIERS.override],
        history: [...PRIOR_SHORTCIRCUIT_TIERS.history],
      },
    },
    pattern: { keywordScores: { ...KEYWORD_SCORES } },
    dial: {
      escalationConfidenceFloor: ESCALATION_CONFIDENCE_FLOOR,
      // null when the dial is off (JUDGE_ESCALATION_MODEL unset).
      escalationModel: escalationModel(),
    },
  };
}

export type PolicySnapshot = ReturnType<typeof describePolicy>;
