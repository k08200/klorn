import { describe, expect, it } from "vitest";
import { riskCoverageThreshold, type ScoredOutcome } from "../selective-threshold.js";

const rows = (spec: Array<[number, boolean]>): ScoredOutcome[] =>
  spec.map(([confidence, correct]) => ({ confidence, correct }));

describe("riskCoverageThreshold (selective prediction / risk-coverage)", () => {
  it("returns threshold 0 with full coverage when every decision is correct", () => {
    const r = riskCoverageThreshold(
      rows([
        [0.9, true],
        [0.6, true],
        [0.3, true],
      ]),
      { alpha: 0.1 },
    );
    expect(r).not.toBeNull();
    expect(r?.errorRate).toBe(0);
    expect(r?.covered).toBe(3);
    expect(r?.coverage).toBe(1);
    // Nothing needs to be excluded, so the accept threshold is the lowest score.
    expect(r?.threshold).toBe(0.3);
  });

  it("finds the max-coverage threshold that keeps error at/under alpha (clean separation)", () => {
    // High-confidence rows are all correct; low-confidence are all wrong.
    const r = riskCoverageThreshold(
      rows([
        [0.9, true],
        [0.85, true],
        [0.8, true],
        [0.4, false],
        [0.3, false],
      ]),
      { alpha: 0 },
    );
    expect(r).not.toBeNull();
    expect(r?.errorRate).toBe(0);
    expect(r?.covered).toBe(3); // only the 3 correct high-conf rows accepted
    expect(r?.threshold).toBe(0.8); // accept confidence >= 0.8
  });

  it("accepts more coverage when alpha tolerates some error", () => {
    // One wrong row sits among the accepted set; alpha=0.25 permits it.
    const data = rows([
      [0.9, true],
      [0.8, true],
      [0.7, false],
      [0.6, true],
      [0.2, false],
    ]);
    const strict = riskCoverageThreshold(data, { alpha: 0 });
    const loose = riskCoverageThreshold(data, { alpha: 0.25 });
    expect(loose).not.toBeNull();
    // Looser alpha covers at least as many as strict.
    expect(loose?.covered ?? 0).toBeGreaterThanOrEqual(strict?.covered ?? 0);
    expect(loose?.errorRate ?? 1).toBeLessThanOrEqual(0.25);
  });

  it("returns null when even the single most-confident row violates alpha", () => {
    const r = riskCoverageThreshold(
      rows([
        [0.95, false],
        [0.9, false],
      ]),
      { alpha: 0 },
    );
    expect(r).toBeNull();
  });

  it("returns null when no threshold covers at least minCovered rows under alpha", () => {
    // Only one correct row; requiring 3 covered under alpha=0 is impossible.
    const r = riskCoverageThreshold(
      rows([
        [0.9, true],
        [0.5, false],
        [0.4, false],
      ]),
      {
        alpha: 0,
        minCovered: 3,
      },
    );
    expect(r).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(riskCoverageThreshold([], { alpha: 0.1 })).toBeNull();
  });

  it("prefers the widest coverage, breaking ties toward the safer (higher) threshold", () => {
    // Two thresholds could satisfy alpha with equal coverage → pick higher τ.
    const r = riskCoverageThreshold(
      rows([
        [0.9, true],
        [0.8, true],
      ]),
      { alpha: 0 },
    );
    expect(r?.covered).toBe(2);
    expect(r?.threshold).toBe(0.8);
  });
});
