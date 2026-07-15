/**
 * Unit tests for the pure stats helpers backing the calibration CLI.
 * The DB-touching wrappers live in scripts/calibration.ts and aren't tested
 * here — those are exercised by manual smoke runs against the local DB.
 */

import { describe, expect, it } from "vitest";
import {
  type AttentionRow,
  computeDistribution,
  computeDriftSignal,
  computeGroundTruthAccuracy,
  computeOverrideRate,
  computePerTier,
  isTier,
  quantile,
  type Tier,
  tierStats,
} from "../judge/calibration.js";

const baseDate = new Date("2026-06-01T00:00:00Z");

function row(partial: Partial<AttentionRow> & { tier: string | null }): AttentionRow {
  return {
    id: partial.id ?? "row-1",
    source: partial.source ?? "EMAIL",
    sourceId: partial.sourceId ?? "email-1",
    tier: partial.tier,
    confidence: partial.confidence ?? 0.8,
    createdAt: partial.createdAt ?? baseDate,
  };
}

describe("isTier", () => {
  it.each([
    ["SILENT", true],
    ["QUEUE", true],
    ["PUSH", true],
    ["AUTO", true],
    ["CALL", false],
    ["", false],
    [null, false],
    [undefined, false],
  ] as const)("isTier(%p) → %p", (input, expected) => {
    expect(isTier(input)).toBe(expected);
  });
});

describe("quantile", () => {
  it("returns 0 for empty arrays (defensive)", () => {
    expect(quantile([], 0.5)).toBe(0);
  });

  it("returns the only value for singletons", () => {
    expect(quantile([0.42], 0.1)).toBe(0.42);
    expect(quantile([0.42], 0.9)).toBe(0.42);
  });

  it("interpolates between samples for arbitrary q", () => {
    // For [0, 1, 2, 3], q=0.5 should be 1.5 (midpoint between 1 and 2).
    expect(quantile([0, 1, 2, 3], 0.5)).toBeCloseTo(1.5, 6);
  });

  it("returns the exact extremes at q=0 and q=1", () => {
    expect(quantile([1, 2, 3], 0)).toBe(1);
    expect(quantile([1, 2, 3], 1)).toBe(3);
  });
});

describe("tierStats", () => {
  it("returns null for empty input — no spurious zeros", () => {
    expect(tierStats([])).toBeNull();
  });

  it("computes mean and quantiles to 4 decimals", () => {
    const stats = tierStats([0.5, 0.6, 0.7, 0.8, 0.9]);
    expect(stats).not.toBeNull();
    if (stats === null) return;
    expect(stats.count).toBe(5);
    expect(stats.meanConfidence).toBe(0.7);
    expect(stats.p50).toBe(0.7);
    expect(stats.p10).toBeCloseTo(0.54, 4);
    expect(stats.p90).toBeCloseTo(0.86, 4);
  });
});

describe("computePerTier", () => {
  it("buckets by tier and skips items with null tier", () => {
    const rows = [
      row({ id: "1", tier: "SILENT", confidence: 0.9 }),
      row({ id: "2", tier: "SILENT", confidence: 0.8 }),
      row({ id: "3", tier: "QUEUE", confidence: 0.5 }),
      row({ id: "4", tier: null, confidence: 0.99 }), // skipped
    ];
    const out = computePerTier(rows);
    expect(out.SILENT?.count).toBe(2);
    expect(out.QUEUE?.count).toBe(1);
    expect(out.PUSH).toBeNull();
    expect(out.AUTO).toBeNull();
  });

  it("ignores unknown tier strings (legacy CALL etc.)", () => {
    const rows = [
      row({ id: "1", tier: "CALL", confidence: 0.5 }),
      row({ id: "2", tier: "SILENT", confidence: 0.9 }),
    ];
    const out = computePerTier(rows);
    expect(out.SILENT?.count).toBe(1);
  });
});

describe("computeOverrideRate", () => {
  it("counts overridden items per tier", () => {
    const rows = [
      row({ id: "a", tier: "SILENT" }),
      row({ id: "b", tier: "SILENT" }),
      row({ id: "c", tier: "SILENT" }),
      row({ id: "d", tier: "PUSH" }),
    ];
    const overrides = new Set(["a", "d"]);
    const out = computeOverrideRate(rows, overrides);
    expect(out.SILENT.total).toBe(3);
    expect(out.SILENT.overridden).toBe(1);
    expect(out.SILENT.rate).toBeCloseTo(0.3333, 4);
    expect(out.PUSH.total).toBe(1);
    expect(out.PUSH.overridden).toBe(1);
    expect(out.PUSH.rate).toBe(1);
    expect(out.QUEUE.rate).toBe(0);
    expect(out.AUTO.rate).toBe(0);
  });

  it("zero-rate when tier is empty (no division by zero)", () => {
    const out = computeOverrideRate([], new Set());
    expect(out.SILENT).toEqual({ overridden: 0, total: 0, rate: 0 });
  });
});

describe("computeGroundTruthAccuracy", () => {
  it("matches only EMAIL-sourced rows against ground truth IDs", () => {
    const rows: AttentionRow[] = [
      row({ id: "att-1", source: "EMAIL", sourceId: "email-A", tier: "SILENT" }),
      row({ id: "att-2", source: "EMAIL", sourceId: "email-B", tier: "QUEUE" }),
      row({ id: "att-3", source: "PENDING_ACTION", sourceId: "email-A", tier: "PUSH" }), // skipped
      row({ id: "att-4", source: "EMAIL", sourceId: "email-MISS", tier: "AUTO" }), // not in truth
    ];
    const truth = new Map<string, Tier>([
      ["email-A", "SILENT"],
      ["email-B", "PUSH"], // mismatch — predicted QUEUE
    ]);
    const out = computeGroundTruthAccuracy(rows, truth);
    expect(out.matchedItems).toBe(2);
    expect(out.overallAccuracy).toBe(0.5);
    expect(out.perTier.SILENT?.tp).toBe(1);
    expect(out.perTier.SILENT?.fn).toBe(0);
    expect(out.perTier.QUEUE?.fp).toBe(1);
    expect(out.perTier.PUSH?.fn).toBe(1);
  });

  it("returns overallAccuracy=0 when nothing matches (avoid NaN)", () => {
    const out = computeGroundTruthAccuracy([], new Map());
    expect(out.matchedItems).toBe(0);
    expect(out.overallAccuracy).toBe(0);
  });
});

describe("computeDistribution + computeDriftSignal", () => {
  it("returns all-zero distribution when input is empty", () => {
    const dist = computeDistribution([]);
    expect(dist.SILENT).toBe(0);
    expect(dist.QUEUE).toBe(0);
    expect(dist.PUSH).toBe(0);
    expect(dist.AUTO).toBe(0);
  });

  it("normalizes proportions to sum ≈ 1", () => {
    const rows = [
      row({ id: "1", tier: "SILENT" }),
      row({ id: "2", tier: "SILENT" }),
      row({ id: "3", tier: "QUEUE" }),
      row({ id: "4", tier: "PUSH" }),
    ];
    const dist = computeDistribution(rows);
    expect(dist.SILENT).toBeCloseTo(0.5, 4);
    expect(dist.QUEUE).toBeCloseTo(0.25, 4);
    expect(dist.PUSH).toBeCloseTo(0.25, 4);
    expect(dist.AUTO).toBe(0);
  });

  it("drift signal picks the tier with the largest delta", () => {
    const thisWindow = [
      row({ id: "1", tier: "SILENT" }),
      row({ id: "2", tier: "SILENT" }),
      row({ id: "3", tier: "SILENT" }),
      row({ id: "4", tier: "SILENT" }),
      row({ id: "5", tier: "PUSH" }),
    ]; // 80% SILENT, 20% PUSH
    const prevWindow = [
      row({ id: "1", tier: "SILENT" }),
      row({ id: "2", tier: "QUEUE" }),
      row({ id: "3", tier: "PUSH" }),
      row({ id: "4", tier: "PUSH" }),
    ]; // 25% SILENT, 25% QUEUE, 50% PUSH
    const drift = computeDriftSignal(thisWindow, prevWindow);
    // SILENT delta = |0.8 - 0.25| = 0.55, PUSH delta = |0.2 - 0.5| = 0.3
    expect(drift.deltaMaxTier).toBe("SILENT");
    expect(drift.deltaMax).toBeCloseTo(0.55, 2);
  });
});
