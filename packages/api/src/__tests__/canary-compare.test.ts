/**
 * Run-over-run canary comparison (#769).
 *
 * The PR-gate eval only answers "does the floor still clear on THIS change".
 * The canary compares two runs of the SAME set over time and answers the
 * quieter questions: did any item's verdict flip (boundary instability /
 * provider drift), and by how much did each floor's clearing margin move
 * (silent erosion that never trips a fixed floor). On a fixed set, any
 * metric movement must manifest as at least one flip — so flips are the
 * alarm and margins are the readout.
 */

import { describe, expect, it } from "vitest";
import { compareCanaryRuns, parseCanaryRunReport } from "../canary-compare.js";

function report(
  rows: Array<{ id: string; truth: string; predicted: string; subject?: string; source?: string }>,
  floorChecks: Array<{ name: string; value: number; floor: number; gating: boolean }> = [],
) {
  return parseCanaryRunReport({ metadata: { floorChecks }, rows }, "test");
}

const CHECKS = [
  { name: "overall accuracy", value: 0.86, floor: 0.8, gating: true },
  { name: "PUSH recall", value: 0.92, floor: 0.9, gating: true },
];

describe("compareCanaryRuns", () => {
  it("reports no flips and flat margins for identical runs", () => {
    const run = report(
      [
        { id: "a", truth: "PUSH", predicted: "PUSH" },
        { id: "b", truth: "QUEUE", predicted: "QUEUE" },
      ],
      CHECKS,
    );
    const cmp = compareCanaryRuns(run, run);
    expect(cmp.flips).toEqual([]);
    expect(cmp.comparedCount).toBe(2);
    expect(cmp.marginDeltas).toHaveLength(2);
    for (const d of cmp.marginDeltas) expect(d.delta).toBe(0);
  });

  it("detects a verdict flip on the same item", () => {
    const prev = report([{ id: "a", truth: "PUSH", predicted: "PUSH", subject: "Sev1" }]);
    const curr = report([
      { id: "a", truth: "PUSH", predicted: "QUEUE", subject: "Sev1", source: "llm" },
    ]);
    const cmp = compareCanaryRuns(prev, curr);
    expect(cmp.flips).toHaveLength(1);
    expect(cmp.flips[0]).toMatchObject({
      id: "a",
      truth: "PUSH",
      prevPredicted: "PUSH",
      currPredicted: "QUEUE",
    });
  });

  it("excludes relabeled items from flips (a set edit is not drift)", () => {
    const prev = report([{ id: "a", truth: "PUSH", predicted: "PUSH" }]);
    const curr = report([{ id: "a", truth: "QUEUE", predicted: "QUEUE" }]);
    const cmp = compareCanaryRuns(prev, curr);
    expect(cmp.flips).toEqual([]);
    expect(cmp.relabeledItems).toEqual(["a"]);
  });

  it("lists added and dropped items without alarming on them", () => {
    const prev = report([
      { id: "a", truth: "PUSH", predicted: "PUSH" },
      { id: "gone", truth: "QUEUE", predicted: "QUEUE" },
    ]);
    const curr = report([
      { id: "a", truth: "PUSH", predicted: "PUSH" },
      { id: "new", truth: "SILENT", predicted: "SILENT" },
    ]);
    const cmp = compareCanaryRuns(prev, curr);
    expect(cmp.flips).toEqual([]);
    expect(cmp.addedItems).toEqual(["new"]);
    expect(cmp.droppedItems).toEqual(["gone"]);
    expect(cmp.comparedCount).toBe(1);
  });

  it("computes margin deltas per floor check matched by name", () => {
    const prev = report(
      [{ id: "a", truth: "PUSH", predicted: "PUSH" }],
      [{ name: "PUSH recall", value: 0.92, floor: 0.9, gating: true }],
    );
    const curr = report(
      [{ id: "a", truth: "PUSH", predicted: "PUSH" }],
      [
        { name: "PUSH recall", value: 0.905, floor: 0.9, gating: true },
        { name: "AUTO recall", value: 0.5, floor: 0.5, gating: false },
      ],
    );
    const cmp = compareCanaryRuns(prev, curr);
    expect(cmp.marginDeltas).toHaveLength(1);
    const d = cmp.marginDeltas[0];
    expect(d.name).toBe("PUSH recall");
    expect(d.prevMargin).toBeCloseTo(0.02, 10);
    expect(d.currMargin).toBeCloseTo(0.005, 10);
    expect(d.delta).toBeCloseTo(-0.015, 10);
  });
});

describe("parseCanaryRunReport", () => {
  it("rejects malformed reports with the run label", () => {
    expect(() => parseCanaryRunReport(null, "baseline")).toThrow(/baseline/);
    expect(() =>
      parseCanaryRunReport({ metadata: { floorChecks: [] }, rows: "x" }, "baseline"),
    ).toThrow(/rows/);
    expect(() =>
      parseCanaryRunReport(
        { metadata: { floorChecks: [] }, rows: [{ truth: "PUSH", predicted: "PUSH" }] },
        "current",
      ),
    ).toThrow(/id/);
    expect(() =>
      parseCanaryRunReport({ metadata: { floorChecks: [{ name: "x" }] }, rows: [] }, "current"),
    ).toThrow(/floorChecks/);
  });

  it("accepts a minimal well-formed report", () => {
    const parsed = parseCanaryRunReport(
      {
        metadata: { floorChecks: CHECKS },
        rows: [{ id: "a", truth: "PUSH", predicted: "PUSH" }],
      },
      "current",
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.metadata.floorChecks).toHaveLength(2);
  });
});
