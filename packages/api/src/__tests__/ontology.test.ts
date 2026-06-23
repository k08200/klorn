/**
 * ontology: the shared deterministic-core surface. describePolicy() must be a
 * faithful, JSON-serializable snapshot of every policy module — the read side
 * a second surface consumes.
 */

import { afterEach, describe, expect, it } from "vitest";
import { describePolicy } from "../ontology.js";
import { PRIOR_SHORTCIRCUIT_TIERS, SENDER_PRIOR_POLICY } from "../sender-policy.js";
import { TIER_THRESHOLDS } from "../tier-policy.js";

const ENV_KEY = "JUDGE_ESCALATION_MODEL";

describe("describePolicy", () => {
  const original = process.env[ENV_KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("snapshots every policy axis from the real modules", () => {
    const snap = describePolicy();
    expect(snap.tiers).toEqual(["SILENT", "QUEUE", "PUSH", "AUTO"]);
    // Value-equal but NOT the same reference — the snapshot is a detached copy.
    expect(snap.relation.thresholds).toEqual(TIER_THRESHOLDS);
    expect(snap.relation.thresholds).not.toBe(TIER_THRESHOLDS);
    expect(snap.entity.priorThresholds).toEqual(SENDER_PRIOR_POLICY);
    expect(snap.entity.priorThresholds).not.toBe(SENDER_PRIOR_POLICY);
  });

  it("does not expose live module constants (mutating the snapshot is safe)", () => {
    const snap = describePolicy();
    (snap.relation.thresholds as { lowConfidenceFloor: number }).lowConfidenceFloor = 0.99;
    // The live constant is unchanged — a consumer can't corrupt classification.
    expect(TIER_THRESHOLDS.lowConfidenceFloor).toBe(0.5);
  });

  it("renders prior short-circuit Sets as arrays", () => {
    const snap = describePolicy();
    expect(snap.entity.shortCircuitTiers.override).toEqual([...PRIOR_SHORTCIRCUIT_TIERS.override]);
    expect(snap.entity.shortCircuitTiers.history).toEqual([...PRIOR_SHORTCIRCUIT_TIERS.history]);
  });

  it("includes the keyword-fallback pattern scores (the LLM-down safety net)", () => {
    const snap = describePolicy();
    expect(snap.pattern.keywordScores.senderTrust.marketing).toBe(0.05);
    expect(snap.pattern.keywordScores.urgency.marketing).toBe(0.1);
    expect(snap.pattern.keywordScores.reversibility.marketing).toBe(0.95);
  });

  it("is fully JSON-serializable (no Sets / functions leak through)", () => {
    const snap = describePolicy();
    expect(() => JSON.stringify(snap)).not.toThrow();
    const round = JSON.parse(JSON.stringify(snap));
    expect(round.dial.escalationConfidenceFloor).toBe(0.5);
  });

  it("reflects the live dial state", () => {
    delete process.env[ENV_KEY];
    expect(describePolicy().dial.escalationModel).toBeNull();
    process.env[ENV_KEY] = "anthropic/claude-sonnet-4";
    expect(describePolicy().dial.escalationModel).toBe("anthropic/claude-sonnet-4");
  });
});
