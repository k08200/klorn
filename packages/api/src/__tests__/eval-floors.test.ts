/**
 * Per-tier floor math for the judge eval gates.
 *
 * Floors encode asymmetric failure costs: a missed PUSH (urgent mail the
 * user never saw) is the worst failure; a real mail buried in SILENT is
 * second. Boundaries are calibrated to the committed synthetic set
 * (PUSH n=13 → recall 0.90 allows exactly one miss).
 */

import { describe, expect, it } from "vitest";
import { evaluateTierFloors, parseGateFloorOverrides, type TierPair } from "../eval-floors.js";

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

  it("reports QUEUE and AUTO recall without gating on them", () => {
    // AUTO fully collapses (0/4) and QUEUE misses some, but every GATING check
    // is clean — report.pass must stay true. Report-only is visibility, not a
    // verdict. overall = 42/50 = 0.84; predicted-SILENT stays pure.
    const report = evaluateTierFloors(
      pairs([
        ["PUSH", "PUSH", 13],
        ["SILENT", "SILENT", 12],
        ["QUEUE", "QUEUE", 17],
        ["QUEUE", "AUTO", 4], // QUEUE recall 17/21
        ["AUTO", "QUEUE", 4], // AUTO recall 0/4
      ]),
    );
    const queue = check(report, "QUEUE recall");
    const auto = check(report, "AUTO recall");
    expect(queue.gating).toBe(false);
    expect(auto.gating).toBe(false);
    expect(queue.value).toBeCloseTo(17 / 21);
    expect(auto.value).toBe(0);
    expect(auto.pass).toBe(false); // below the 0.5 target...
    expect(report.pass).toBe(true); // ...but report-only, so the gate still passes
  });

  it("the gating set is exactly overall accuracy + PUSH recall + SILENT precision", () => {
    const report = evaluateTierFloors(pairs([["QUEUE", "QUEUE", 50]]));
    expect(
      report.checks
        .filter((c) => c.gating)
        .map((c) => c.name)
        .sort(),
    ).toEqual(["PUSH recall", "SILENT precision", "overall accuracy"].sort());
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

describe("evaluateTierFloors overrides (#650 — configurable per-tier gating)", () => {
  it("promotes a report-only check to gating at the given floor", () => {
    // 3/4 AUTO caught (0.75): passes a 0.5 floor, fails a 0.8 one.
    const data = pairs([
      ["AUTO", "AUTO", 3],
      ["AUTO", "QUEUE", 1],
      ["QUEUE", "QUEUE", 46],
    ]);

    const promoted = evaluateTierFloors(data, { "auto-recall": 0.5 });
    const auto = check(promoted, "AUTO recall");
    expect(auto.gating).toBe(true);
    expect(auto.floor).toBe(0.5);
    expect(promoted.pass).toBe(true);

    const strict = evaluateTierFloors(data, { "auto-recall": 0.8 });
    expect(check(strict, "AUTO recall").pass).toBe(false);
    expect(strict.pass).toBe(false);
  });

  it("tightens an already-gating floor", () => {
    // 12/13 PUSH (0.923): passes the default 0.90, fails a 0.95 override.
    const data = pairs([
      ["PUSH", "PUSH", 12],
      ["PUSH", "QUEUE", 1],
      ["QUEUE", "QUEUE", 37],
    ]);
    expect(evaluateTierFloors(data).pass).toBe(true);
    const tightened = evaluateTierFloors(data, { "push-recall": 0.95 });
    expect(check(tightened, "PUSH recall").pass).toBe(false);
    expect(tightened.pass).toBe(false);
  });

  it("leaves untouched checks at their defaults", () => {
    const report = evaluateTierFloors(pairs([["QUEUE", "QUEUE", 50]]), { "auto-recall": 0.5 });
    expect(check(report, "PUSH recall").floor).toBe(0.9);
    expect(check(report, "QUEUE recall").gating).toBe(false);
  });
});

describe("parseGateFloorOverrides", () => {
  it("parses a comma-separated list", () => {
    expect(parseGateFloorOverrides("auto-recall=0.5,push-recall=0.95")).toEqual({
      "auto-recall": 0.5,
      "push-recall": 0.95,
    });
  });

  it("rejects unknown check ids", () => {
    expect(() => parseGateFloorOverrides("spam-recall=0.5")).toThrow(/spam-recall/);
  });

  it("rejects values outside [0, 1] and malformed tokens", () => {
    expect(() => parseGateFloorOverrides("auto-recall=1.5")).toThrow(/auto-recall/);
    expect(() => parseGateFloorOverrides("auto-recall")).toThrow(/auto-recall/);
    expect(() => parseGateFloorOverrides("auto-recall=high")).toThrow(/auto-recall/);
  });

  it("enforces the ratchet: a default-gating floor can only tighten", () => {
    expect(() => parseGateFloorOverrides("push-recall=0.5")).toThrow(/ratchet/i);
    expect(() => parseGateFloorOverrides("overall=0.7")).toThrow(/ratchet/i);
    // Equal to the default is allowed (no-op), and report-only checks may
    // gate at any floor — they had no committed floor to lower.
    expect(parseGateFloorOverrides("push-recall=0.9")).toEqual({ "push-recall": 0.9 });
    expect(parseGateFloorOverrides("queue-recall=0.1")).toEqual({ "queue-recall": 0.1 });
  });
});
