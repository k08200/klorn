/**
 * Per-tier precision/recall/support math and body off-vs-on delta math.
 *
 * These are the "measure not inject" instruments: a tier with no support is
 * UNKNOWN (null), never an invented 0 or 1. The tests pin that null contract
 * for both the metric computation and the delta between two runs so a vacuous
 * tier can never be reported as a confident number.
 */

import { describe, expect, it } from "vitest";
import { computePerTierMetrics, diffTierMetrics, type TierMetric } from "../eval-floors.js";
import { TIERS, type Tier } from "../tiers.js";

function results(
  spec: Array<[truth: Tier, predicted: Tier, count: number]>,
): Array<{ truth: Tier; predicted: Tier }> {
  const out: Array<{ truth: Tier; predicted: Tier }> = [];
  for (const [truth, predicted, count] of spec) {
    for (let i = 0; i < count; i++) out.push({ truth, predicted });
  }
  return out;
}

function metric(metrics: TierMetric[], tier: Tier): TierMetric {
  const found = metrics.find((m) => m.tier === tier);
  if (!found) throw new Error(`missing metric: ${tier}`);
  return found;
}

describe("computePerTierMetrics", () => {
  it("returns one metric per tier in TIERS order", () => {
    const metrics = computePerTierMetrics(results([["QUEUE", "QUEUE", 1]]));
    expect(metrics.map((m) => m.tier)).toEqual([...TIERS]);
  });

  it("computes precision and recall from a hand-built result set", () => {
    // PUSH: truth=3 (2 hit, 1 → QUEUE), predicted=4 (2 correct + 2 QUEUE→PUSH).
    //   precision = 2/4 = 0.5, recall = 2/3.
    // QUEUE: truth=4 (2 hit + 2 → PUSH), predicted=3 (2 correct + 1 PUSH→QUEUE).
    //   precision = 2/3, recall = 2/4 = 0.5.
    const metrics = computePerTierMetrics(
      results([
        ["PUSH", "PUSH", 2],
        ["PUSH", "QUEUE", 1],
        ["QUEUE", "QUEUE", 2],
        ["QUEUE", "PUSH", 2],
      ]),
    );

    const push = metric(metrics, "PUSH");
    expect(push.precision).toBeCloseTo(2 / 4);
    expect(push.recall).toBeCloseTo(2 / 3);
    expect(push.truthSupport).toBe(3);
    expect(push.predictedSupport).toBe(4);

    const queue = metric(metrics, "QUEUE");
    expect(queue.precision).toBeCloseTo(2 / 3);
    expect(queue.recall).toBeCloseTo(2 / 4);
    expect(queue.truthSupport).toBe(4);
    expect(queue.predictedSupport).toBe(3);
  });

  it("reports null (not 0, not NaN) for a tier with zero support, with counts", () => {
    // Nothing is truth=AUTO and nothing is predicted=AUTO → both denominators 0.
    const metrics = computePerTierMetrics(results([["QUEUE", "QUEUE", 5]]));
    const auto = metric(metrics, "AUTO");
    expect(auto.precision).toBeNull();
    expect(auto.recall).toBeNull();
    expect(auto.truthSupport).toBe(0);
    expect(auto.predictedSupport).toBe(0);

    // A tier predicted but never true: recall denominator 0 → null recall,
    // but precision is a real 0 (every prediction was wrong).
    const skewed = computePerTierMetrics(
      results([
        ["QUEUE", "SILENT", 3],
        ["QUEUE", "QUEUE", 1],
      ]),
    );
    const silent = metric(skewed, "SILENT");
    expect(silent.recall).toBeNull(); // no SILENT truth
    expect(silent.truthSupport).toBe(0);
    expect(silent.predictedSupport).toBe(3);
    expect(silent.precision).toBe(0); // 0/3 predicted correct — a real, known 0
  });

  it("perfect run yields precision=recall=1 for every supported tier", () => {
    const metrics = computePerTierMetrics(
      results([
        ["PUSH", "PUSH", 3],
        ["SILENT", "SILENT", 2],
        ["QUEUE", "QUEUE", 4],
        ["AUTO", "AUTO", 1],
      ]),
    );
    for (const m of metrics) {
      expect(m.precision).toBe(1);
      expect(m.recall).toBe(1);
    }
  });
});

describe("diffTierMetrics", () => {
  const before: TierMetric[] = [
    { tier: "SILENT", precision: 0.5, recall: 0.4, truthSupport: 5, predictedSupport: 4 },
    { tier: "QUEUE", precision: 0.8, recall: 0.6, truthSupport: 10, predictedSupport: 8 },
    { tier: "PUSH", precision: null, recall: 0.2, truthSupport: 5, predictedSupport: 0 },
    { tier: "AUTO", precision: 0.3, recall: null, truthSupport: 0, predictedSupport: 3 },
  ];

  it("computes numeric deltas where both sides are known", () => {
    const after: TierMetric[] = [
      { tier: "SILENT", precision: 0.9, recall: 0.8, truthSupport: 5, predictedSupport: 5 },
      { tier: "QUEUE", precision: 0.8, recall: 0.6, truthSupport: 10, predictedSupport: 8 },
      { tier: "PUSH", precision: 0.7, recall: 0.5, truthSupport: 5, predictedSupport: 6 },
      { tier: "AUTO", precision: 0.3, recall: 0.4, truthSupport: 4, predictedSupport: 3 },
    ];
    const diff = diffTierMetrics(before, after);
    const silent = diff.find((d) => d.tier === "SILENT");
    if (!silent) throw new Error("missing SILENT diff");
    expect(silent.precisionDelta).toBeCloseTo(0.4);
    expect(silent.recallDelta).toBeCloseTo(0.4);

    const queue = diff.find((d) => d.tier === "QUEUE");
    if (!queue) throw new Error("missing QUEUE diff");
    expect(queue.precisionDelta).toBe(0);
    expect(queue.recallDelta).toBe(0);
  });

  it("returns null delta when either side is null (never invents a number)", () => {
    const after: TierMetric[] = [
      { tier: "SILENT", precision: null, recall: 0.8, truthSupport: 5, predictedSupport: 0 },
      { tier: "QUEUE", precision: 0.8, recall: null, truthSupport: 10, predictedSupport: 8 },
      { tier: "PUSH", precision: 0.7, recall: 0.5, truthSupport: 5, predictedSupport: 6 },
      { tier: "AUTO", precision: 0.3, recall: 0.4, truthSupport: 4, predictedSupport: 3 },
    ];
    const diff = diffTierMetrics(before, after);

    // SILENT: after.precision null → precisionDelta null; recall both known.
    const silent = diff.find((d) => d.tier === "SILENT");
    if (!silent) throw new Error("missing SILENT diff");
    expect(silent.precisionDelta).toBeNull();
    expect(silent.recallDelta).toBeCloseTo(0.4);

    // QUEUE: after.recall null → recallDelta null; precision both known (=0).
    const queue = diff.find((d) => d.tier === "QUEUE");
    if (!queue) throw new Error("missing QUEUE diff");
    expect(queue.precisionDelta).toBe(0);
    expect(queue.recallDelta).toBeNull();

    // PUSH: before.precision null → precisionDelta null; before.recall known → recall delta real.
    const push = diff.find((d) => d.tier === "PUSH");
    if (!push) throw new Error("missing PUSH diff");
    expect(push.precisionDelta).toBeNull();
    expect(push.recallDelta).toBeCloseTo(0.3);

    // AUTO: before.recall null → recallDelta null; precision both known (=0).
    const auto = diff.find((d) => d.tier === "AUTO");
    if (!auto) throw new Error("missing AUTO diff");
    expect(auto.precisionDelta).toBe(0);
    expect(auto.recallDelta).toBeNull();
  });

  it("emits one diff per tier in TIERS order", () => {
    const diff = diffTierMetrics(before, before);
    expect(diff.map((d) => d.tier)).toEqual([...TIERS]);
    for (const d of diff) {
      // before vs before: every known pair diffs to 0, null pairs to null.
      if (d.precisionDelta !== null) expect(d.precisionDelta).toBe(0);
      if (d.recallDelta !== null) expect(d.recallDelta).toBe(0);
    }
  });
});
