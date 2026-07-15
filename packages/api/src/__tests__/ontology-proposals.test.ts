import { describe, expect, it } from "vitest";
import {
  MAX_STEP,
  MIN_SAMPLE,
  type ProposalSignals,
  PUSH_RECALL_TARGET,
  proposeThresholdAdjustments,
  SILENT_OVERSUPPRESS_TARGET,
} from "../learning/ontology-proposals.js";
import { TIER_THRESHOLDS } from "../tier-policy.js";

/** Signals with everything healthy (no proposal should fire). */
const HEALTHY: ProposalSignals = {
  recallUpperBound: 0.98,
  pushRecallSample: 100,
  overSuppressionRate: 0.0,
  silentSample: 100,
};

describe("proposeThresholdAdjustments", () => {
  it("proposes LOWER on tier.push.confidence when PUSH recall is below target with enough samples", () => {
    const out = proposeThresholdAdjustments({
      ...HEALTHY,
      recallUpperBound: 0.5,
      pushRecallSample: 50,
    });
    const push = out.find((p) => p.knob === "tier.push.confidence");
    expect(push).toBeDefined();
    expect(push?.direction).toBe("LOWER");
    expect(push?.currentValue).toBe(TIER_THRESHOLDS.push.confidence);
    expect(push?.proposedValue).toBeCloseTo(TIER_THRESHOLDS.push.confidence - MAX_STEP, 10);
    expect(push?.evidence.metric).toBe("push.recallUpperBound");
    expect(push?.evidence.sampleSize).toBe(50);
  });

  it("proposes RAISE on tier.silent.reversibility when SILENT over-suppression is above target", () => {
    const out = proposeThresholdAdjustments({
      ...HEALTHY,
      overSuppressionRate: 0.4,
      silentSample: 50,
    });
    const silent = out.find((p) => p.knob === "tier.silent.reversibility");
    expect(silent).toBeDefined();
    expect(silent?.direction).toBe("RAISE");
    expect(silent?.currentValue).toBe(TIER_THRESHOLDS.silent.reversibility);
    expect(silent?.proposedValue).toBeCloseTo(TIER_THRESHOLDS.silent.reversibility + MAX_STEP, 10);
    expect(silent?.evidence.metric).toBe("silent.overSuppressionRate");
  });

  it("emits no proposal when samples are below the floor", () => {
    const out = proposeThresholdAdjustments({
      recallUpperBound: 0.1,
      pushRecallSample: MIN_SAMPLE - 1,
      overSuppressionRate: 0.9,
      silentSample: MIN_SAMPLE - 1,
    });
    expect(out).toEqual([]);
  });

  it("emits no proposal when metrics are within target", () => {
    expect(proposeThresholdAdjustments(HEALTHY)).toEqual([]);
  });

  it("emits no proposal when metrics are null (no data)", () => {
    const out = proposeThresholdAdjustments({
      recallUpperBound: null,
      pushRecallSample: 0,
      overSuppressionRate: null,
      silentSample: 0,
    });
    expect(out).toEqual([]);
  });

  it("respects MAX_STEP and clamps proposed values to [0,1]", () => {
    const out = proposeThresholdAdjustments(
      { ...HEALTHY, overSuppressionRate: 0.9, silentSample: 99 },
      {
        thresholds: {
          ...TIER_THRESHOLDS,
          silent: { ...TIER_THRESHOLDS.silent, reversibility: 0.99 },
        },
      },
    );
    const silent = out.find((p) => p.knob === "tier.silent.reversibility");
    // 0.99 + 0.05 would be 1.04 → clamped to 1.
    expect(silent?.proposedValue).toBe(1);
  });

  it("does not propose a push change that would cross the lowConfidenceFloor (QUEUE floor)", () => {
    const out = proposeThresholdAdjustments(
      { ...HEALTHY, recallUpperBound: 0.1, pushRecallSample: 99 },
      {
        thresholds: {
          ...TIER_THRESHOLDS,
          lowConfidenceFloor: 0.69,
          push: { ...TIER_THRESHOLDS.push, confidence: 0.7 },
        },
        maxStep: 0.05,
      },
    );
    const push = out.find((p) => p.knob === "tier.push.confidence");
    // 0.7 - 0.05 = 0.65 would cross the 0.69 QUEUE floor → clamp to the floor.
    expect(push?.proposedValue).toBe(0.69);
  });

  it("emits no push proposal when confidence is already at the QUEUE floor (no movement)", () => {
    const out = proposeThresholdAdjustments(
      { ...HEALTHY, recallUpperBound: 0.1, pushRecallSample: 99 },
      {
        thresholds: {
          ...TIER_THRESHOLDS,
          lowConfidenceFloor: 0.7,
          push: { ...TIER_THRESHOLDS.push, confidence: 0.7 },
        },
      },
    );
    expect(out.find((p) => p.knob === "tier.push.confidence")).toBeUndefined();
  });

  it("exposes the targets it gates on", () => {
    expect(PUSH_RECALL_TARGET).toBe(0.9);
    expect(SILENT_OVERSUPPRESS_TARGET).toBe(0.1);
  });
});
