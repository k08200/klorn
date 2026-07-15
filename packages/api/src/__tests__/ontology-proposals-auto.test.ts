import { describe, expect, it } from "vitest";
import { proposeAutoConfidenceAdjustment } from "../learning/ontology-proposals.js";
import type { ScoredOutcome } from "../selective-threshold.js";

// Base auto.confidence gate is 0.85 (tier-policy TIER_THRESHOLDS.auto.confidence).
// Defaults: minSample 20, maxStep 0.05, autoErrorTarget 0.05.

const repeat = (n: number, confidence: number, correct: boolean): ScoredOutcome[] =>
  Array.from({ length: n }, () => ({ confidence, correct }));

describe("proposeAutoConfidenceAdjustment (risk-coverage AUTO calibration)", () => {
  it("returns null on thin data (below minSample)", () => {
    expect(proposeAutoConfidenceAdjustment(repeat(5, 0.7, true))).toBeNull();
  });

  it("proposes LOWER when the gate is over-cautious (headroom for more AUTO recall)", () => {
    // 20 correct AUTO decisions at confidence 0.6 → safe cutoff is well below 0.85.
    const p = proposeAutoConfidenceAdjustment(repeat(20, 0.6, true));
    expect(p).not.toBeNull();
    expect(p?.knob).toBe("tier.auto.confidence");
    expect(p?.direction).toBe("LOWER");
    // Bounded by maxStep: 0.85 - 0.05.
    expect(p?.proposedValue).toBeCloseTo(0.8, 10);
    expect(p?.evidence.value).toBe(0.6); // the risk-coverage cutoff
  });

  it("proposes RAISE when observed AUTO error demands a tighter gate", () => {
    // Clean only at >= 0.9; a band at 0.87 carries 30% error (exceeds alpha).
    const rows = [...repeat(20, 0.9, true), ...repeat(7, 0.87, true), ...repeat(3, 0.87, false)];
    const p = proposeAutoConfidenceAdjustment(rows);
    expect(p).not.toBeNull();
    expect(p?.direction).toBe("RAISE");
    expect(p?.proposedValue).toBeCloseTo(0.9, 10); // 0.85 + 0.05 (bounded)
    expect(p?.evidence.value).toBe(0.9);
  });

  it("returns null when NO confidence cutoff keeps AUTO error under alpha", () => {
    // 25 rows all at the same confidence with 20% error — no threshold is safe.
    const rows = [...repeat(20, 0.9, true), ...repeat(5, 0.9, false)];
    expect(proposeAutoConfidenceAdjustment(rows)).toBeNull();
  });

  it("returns null when the gate is already calibrated (no movement)", () => {
    // Safe cutoff lands exactly on the current 0.85 gate.
    const rows = [...repeat(20, 0.85, true), ...repeat(5, 0.5, false)];
    expect(proposeAutoConfidenceAdjustment(rows)).toBeNull();
  });

  it("only ever proposes reversible, bounded movement of the auto.confidence knob", () => {
    const p = proposeAutoConfidenceAdjustment(repeat(30, 0.55, true));
    expect(p?.knob).toBe("tier.auto.confidence");
    // Never moves more than maxStep from the current gate in one run.
    expect(Math.abs((p?.proposedValue ?? 0.85) - 0.85)).toBeLessThanOrEqual(0.05 + 1e-9);
  });
});
