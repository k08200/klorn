/**
 * Per-tier floor math for the judge eval gates.
 *
 * Floors encode asymmetric failure costs: a missed PUSH (urgent mail the
 * user never saw) is the worst failure; a real mail buried in SILENT is
 * second. Boundaries are calibrated to the committed synthetic set
 * (PUSH n=13 → recall 0.90 allows exactly one miss).
 */

import { describe, expect, it } from "vitest";
import { evaluateTierFloors, type TierPair } from "../eval-floors.js";

function pairs(spec: Array<[truth: string, predicted: string, count: number]>): TierPair[] {
  const out: TierPair[] = [];
  for (const [truth, predicted, count] of spec) {
    for (let i = 0; i < count; i++) {
      out.push({ truth, predicted } as TierPair);
    }
  }
  return out;
}

function check(report: ReturnType<typeof evaluateTierFloors>, name: string) {
  const found = report.checks.find((c) => c.name === name);
  if (!found) throw new Error(`missing check: ${name}`);
  return found;
}

describe("evaluateTierFloors", () => {
  it("passes a clean run", () => {
    const report = evaluateTierFloors(
      pairs([
        ["PUSH", "PUSH", 13],
        ["SILENT", "SILENT", 12],
        ["QUEUE", "QUEUE", 21],
        ["AUTO", "AUTO", 4],
      ]),
    );
    expect(report.pass).toBe(true);
    expect(check(report, "PUSH recall").value).toBe(1);
    expect(check(report, "SILENT precision").value).toBe(1);
  });

  it("PUSH recall: one miss of 13 passes (12/13 ≥ 0.90), two misses fail", () => {
    const oneMiss = evaluateTierFloors(
      pairs([
        ["PUSH", "PUSH", 12],
        ["PUSH", "QUEUE", 1],
        ["QUEUE", "QUEUE", 37],
      ]),
    );
    expect(check(oneMiss, "PUSH recall").pass).toBe(true);

    const twoMisses = evaluateTierFloors(
      pairs([
        ["PUSH", "PUSH", 11],
        ["PUSH", "QUEUE", 2],
        ["QUEUE", "QUEUE", 37],
      ]),
    );
    expect(check(twoMisses, "PUSH recall").pass).toBe(false);
    expect(twoMisses.pass).toBe(false);
  });

  it("SILENT precision: one real mail in 10 predicted-SILENT passes (0.90), two fail", () => {
    const oneFalseSilent = evaluateTierFloors(
      pairs([
        ["SILENT", "SILENT", 9],
        ["QUEUE", "SILENT", 1], // one real mail buried
        ["QUEUE", "QUEUE", 40],
      ]),
    );
    expect(check(oneFalseSilent, "SILENT precision").pass).toBe(true);

    const twoFalseSilent = evaluateTierFloors(
      pairs([
        ["SILENT", "SILENT", 9],
        ["QUEUE", "SILENT", 2],
        ["QUEUE", "QUEUE", 39],
      ]),
    );
    expect(check(twoFalseSilent, "SILENT precision").pass).toBe(false);
  });

  it("overall accuracy: 39/50 fails the 0.80 bar, 40/50 passes", () => {
    const failing = evaluateTierFloors(
      pairs([
        ["QUEUE", "QUEUE", 39],
        ["QUEUE", "PUSH", 11],
      ]),
    );
    expect(check(failing, "overall accuracy").pass).toBe(false);

    const passing = evaluateTierFloors(
      pairs([
        ["QUEUE", "QUEUE", 40],
        ["QUEUE", "AUTO", 10],
      ]),
    );
    expect(check(passing, "overall accuracy").pass).toBe(true);
  });

  it("vacuous tiers pass (no PUSH support / nothing predicted SILENT), empty input fails", () => {
    const noSupport = evaluateTierFloors(pairs([["QUEUE", "QUEUE", 50]]));
    expect(check(noSupport, "PUSH recall").pass).toBe(true);
    expect(check(noSupport, "SILENT precision").pass).toBe(true);
    expect(noSupport.pass).toBe(true);

    // No data must never green-light a gate.
    const empty = evaluateTierFloors([]);
    expect(empty.pass).toBe(false);
  });
});
