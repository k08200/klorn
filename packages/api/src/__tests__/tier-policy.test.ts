/**
 * tier-policy boundary tests — the deterministic core of the firewall.
 *
 * poc-judge.test.ts already exercises tierFromFeatures at the branch level (a
 * representative vector per tier). This file pins the EXACT threshold edges so a
 * future calibration pass (or a stray `>=`→`>` edit) that shifts a boundary
 * fails loudly instead of silently re-tiering mail. Every constant in
 * TIER_THRESHOLDS is asserted at its on/just-inside/just-outside edge.
 */

import { describe, expect, it } from "vitest";
import { TIER_THRESHOLDS, type TierFeatures, tierFromFeatures } from "../tier-policy.js";

/** Neutral baseline that lands in the default QUEUE; override per assertion. */
const feat = (o: Partial<TierFeatures> = {}): TierFeatures => ({
  confidence: 0.6,
  senderTrust: 0.5,
  reversibility: 0.5,
  urgency: 0.1,
  ...o,
});
const tierOf = (o: Partial<TierFeatures> = {}) => tierFromFeatures(feat(o)).tier;

describe("tierFromFeatures — branch 1: low-confidence floor (0.5, strict <)", () => {
  it("confidence just below 0.5 → QUEUE via the low-confidence floor", () => {
    const r = tierFromFeatures(feat({ confidence: 0.49 }));
    expect(r.tier).toBe("QUEUE");
    expect(r.reason).toContain("Low classification confidence");
  });

  it("confidence exactly 0.5 does NOT trip the floor", () => {
    const r = tierFromFeatures(feat({ confidence: 0.5 }));
    expect(r.reason).not.toContain("Low classification confidence");
  });

  it("low confidence wins over a PUSH-looking signal (never interrupt on uncertainty)", () => {
    // urgency 0.9 + confidence 0.9 would PUSH, but confidence 0.4 floors it first.
    expect(tierOf({ confidence: 0.4, urgency: 0.9 })).toBe("QUEUE");
  });
});

describe("tierFromFeatures — branch 2: PUSH (urgency ≥ 0.7 AND confidence ≥ 0.7)", () => {
  it("both exactly at threshold → PUSH", () => {
    expect(tierOf({ urgency: 0.7, confidence: 0.7 })).toBe("PUSH");
  });

  it("urgency just below 0.7 → not PUSH", () => {
    expect(tierOf({ urgency: 0.69, confidence: 0.7 })).not.toBe("PUSH");
  });

  it("confidence just below 0.7 (still above the floor) → not PUSH", () => {
    expect(tierOf({ urgency: 0.7, confidence: 0.69 })).not.toBe("PUSH");
  });
});

describe("tierFromFeatures — branch 3: SILENT (trust < 0.2 AND urgency < 0.2 AND reversibility > 0.9)", () => {
  const silentish = { senderTrust: 0.1, urgency: 0.1, reversibility: 0.95, confidence: 0.6 };

  it("just inside all three gates → SILENT", () => {
    expect(tierOf({ ...silentish, senderTrust: 0.19 })).toBe("SILENT");
  });

  it("senderTrust exactly 0.2 → not SILENT", () => {
    expect(tierOf({ ...silentish, senderTrust: 0.2 })).not.toBe("SILENT");
  });

  it("urgency exactly 0.2 → not SILENT", () => {
    expect(tierOf({ ...silentish, urgency: 0.2 })).not.toBe("SILENT");
  });

  it("reversibility exactly 0.9 → not SILENT (needs strictly greater)", () => {
    expect(tierOf({ ...silentish, reversibility: 0.9 })).not.toBe("SILENT");
  });
});

describe("tierFromFeatures — branch 4: AUTO (rev ≥ 0.85 AND conf ≥ 0.85 AND urgency < 0.5 AND trust ≥ 0.5)", () => {
  const autoish = { reversibility: 0.85, confidence: 0.85, urgency: 0.49, senderTrust: 0.5 };

  it("all four exactly at threshold → AUTO", () => {
    expect(tierOf(autoish)).toBe("AUTO");
  });

  it("reversibility just below 0.85 → not AUTO", () => {
    expect(tierOf({ ...autoish, reversibility: 0.84 })).not.toBe("AUTO");
  });

  it("confidence just below 0.85 → not AUTO", () => {
    expect(tierOf({ ...autoish, confidence: 0.84 })).not.toBe("AUTO");
  });

  it("urgency exactly 0.5 → not AUTO (needs strictly less)", () => {
    expect(tierOf({ ...autoish, urgency: 0.5 })).not.toBe("AUTO");
  });

  it("senderTrust just below 0.5 → not AUTO (the 2026-06-12 trust floor)", () => {
    expect(tierOf({ ...autoish, senderTrust: 0.49 })).not.toBe("AUTO");
  });
});

describe("TIER_THRESHOLDS — single source of truth", () => {
  it("holds the documented, tuned values", () => {
    expect(TIER_THRESHOLDS.lowConfidenceFloor).toBe(0.5);
    expect(TIER_THRESHOLDS.push).toEqual({ urgency: 0.7, confidence: 0.7 });
    expect(TIER_THRESHOLDS.silent).toEqual({ senderTrust: 0.2, urgency: 0.2, reversibility: 0.9 });
    expect(TIER_THRESHOLDS.auto).toEqual({
      reversibility: 0.85,
      confidence: 0.85,
      urgency: 0.5,
      senderTrust: 0.5,
    });
  });
});
