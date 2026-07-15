import { afterEach, describe, expect, it } from "vitest";
import { TIER_THRESHOLDS, tierFromFeatures } from "../judge/tier-policy.js";
import {
  applyOverrides,
  buildEffectiveThresholds,
  getEffectiveThresholds,
  resetOverrideCache,
} from "../learning/ontology-overrides.js";

const BASE = TIER_THRESHOLDS;

// applyOverrides mutates the module-global effective cache, which the live judge
// reads. Reset after every test so a mutation here can never leak into another
// test (or another file's judge call) and silently retune classification.
afterEach(() => resetOverrideCache());

describe("buildEffectiveThresholds", () => {
  it("returns base values when there are no overrides", () => {
    const eff = buildEffectiveThresholds(BASE, []);
    expect(eff.push.confidence).toBe(BASE.push.confidence);
    expect(eff.silent.reversibility).toBe(BASE.silent.reversibility);
    expect(eff.lowConfidenceFloor).toBe(BASE.lowConfidenceFloor);
  });

  it("applies a valid override onto a deep copy without mutating base", () => {
    const eff = buildEffectiveThresholds(BASE, [
      { knob: "tier.push.confidence", proposedValue: 0.6, updatedAt: "2026-06-23T00:00:00Z" },
    ]);
    expect(eff.push.confidence).toBe(0.6);
    expect(TIER_THRESHOLDS.push.confidence).toBe(0.7); // base untouched
    expect(eff.push.urgency).toBe(BASE.push.urgency); // siblings preserved
  });

  it("takes the most recent applied row per knob", () => {
    const eff = buildEffectiveThresholds(BASE, [
      { knob: "tier.push.confidence", proposedValue: 0.65, updatedAt: "2026-06-20T00:00:00Z" },
      { knob: "tier.push.confidence", proposedValue: 0.6, updatedAt: "2026-06-23T00:00:00Z" },
    ]);
    expect(eff.push.confidence).toBe(0.6);
  });

  it("ignores an out-of-range value", () => {
    const eff = buildEffectiveThresholds(BASE, [
      { knob: "tier.silent.reversibility", proposedValue: 1.4, updatedAt: "2026-06-23T00:00:00Z" },
    ]);
    expect(eff.silent.reversibility).toBe(BASE.silent.reversibility);
  });

  it("ignores a push.confidence override that would cross the QUEUE floor", () => {
    const eff = buildEffectiveThresholds(BASE, [
      // 0.4 <= lowConfidenceFloor (0.5) → would make PUSH unreachable → reverted.
      { knob: "tier.push.confidence", proposedValue: 0.4, updatedAt: "2026-06-23T00:00:00Z" },
    ]);
    expect(eff.push.confidence).toBe(BASE.push.confidence);
  });

  it("ignores an unknown knob without crashing", () => {
    const eff = buildEffectiveThresholds(BASE, [
      { knob: "tier.bogus.field", proposedValue: 0.5, updatedAt: "2026-06-23T00:00:00Z" },
    ]);
    expect(eff).toEqual(buildEffectiveThresholds(BASE, []));
  });

  it("reverts BOTH knobs when lowConfidenceFloor is raised above push.confidence", () => {
    // Raising only the floor to 0.85 (> base push.confidence 0.7) would make PUSH
    // unreachable. The invariant must drop both back to base.
    const eff = buildEffectiveThresholds(BASE, [
      { knob: "tier.lowConfidenceFloor", proposedValue: 0.85, updatedAt: "2026-06-23T00:00:00Z" },
    ]);
    expect(eff.lowConfidenceFloor).toBe(BASE.lowConfidenceFloor);
    expect(eff.push.confidence).toBe(BASE.push.confidence);
    expect(eff.push.confidence).toBeGreaterThan(eff.lowConfidenceFloor);
  });

  it("ignores prototype-polluting knob keys (__proto__, constructor)", () => {
    const eff = buildEffectiveThresholds(BASE, [
      { knob: "__proto__", proposedValue: 0.5, updatedAt: "2026-06-23T00:00:00Z" },
      { knob: "constructor", proposedValue: 0.5, updatedAt: "2026-06-23T00:00:00Z" },
    ]);
    expect(eff).toEqual(buildEffectiveThresholds(BASE, []));
  });
});

describe("tierFromFeatures with an effective config", () => {
  it("changes the decision when the threshold is overridden", () => {
    const features = { confidence: 0.65, senderTrust: 0.5, reversibility: 0.5, urgency: 0.75 };
    // Base: push needs confidence>=0.7, so 0.65 → not PUSH (QUEUE).
    expect(tierFromFeatures(features).tier).not.toBe("PUSH");
    // Lower push.confidence to 0.6 → now PUSH.
    const eff = buildEffectiveThresholds(BASE, [
      { knob: "tier.push.confidence", proposedValue: 0.6, updatedAt: "2026-06-23T00:00:00Z" },
    ]);
    expect(tierFromFeatures(features, eff).tier).toBe("PUSH");
  });
});

describe("override cache", () => {
  it("returns base before any apply (eval-safety invariant)", () => {
    resetOverrideCache();
    expect(getEffectiveThresholds().push.confidence).toBe(BASE.push.confidence);
  });

  it("reflects applied overrides after applyOverrides, and resets", () => {
    applyOverrides([
      { knob: "tier.push.confidence", proposedValue: 0.6, updatedAt: "2026-06-23T00:00:00Z" },
    ]);
    expect(getEffectiveThresholds().push.confidence).toBe(0.6);
    resetOverrideCache();
    expect(getEffectiveThresholds().push.confidence).toBe(BASE.push.confidence);
  });
});
