import { describe, expect, it } from "vitest";
import { type DecisionRow, summarizeConfusion } from "../decision-metrics.js";

const row = (shownTier: string, outcome: string | null): DecisionRow => ({ shownTier, outcome });

describe("summarizeConfusion (per-tier real accuracy from confirmed overrides)", () => {
  it("is empty on no rows", () => {
    const c = summarizeConfusion([]);
    expect(c.total).toBe(0);
    expect(c.confirmedOverrides).toBe(0);
    expect(c.matrix).toEqual({});
    expect(c.perTier.every((t) => t.shown === 0 && t.correctionRate === null)).toBe(true);
  });

  it("counts a confirmed override as a shown→revealed matrix cell + correction", () => {
    const c = summarizeConfusion([row("PUSH", "OVERRIDE:QUEUE")]);
    expect(c.confirmedOverrides).toBe(1);
    expect(c.matrix).toEqual({ PUSH: { QUEUE: 1 } });
    const push = c.perTier.find((t) => t.tier === "PUSH");
    expect(push).toMatchObject({
      shown: 1,
      overriddenAway: 1,
      correctionRate: 1,
      movedTo: { QUEUE: 1 },
    });
  });

  it("does NOT count unconfirmed (null / terminal non-override) outcomes as errors", () => {
    const c = summarizeConfusion([
      row("PUSH", null), // open — unconfirmed
      row("PUSH", "DISMISSED"), // terminal, not a tier move
      row("QUEUE", "OPENED"),
    ]);
    expect(c.confirmedOverrides).toBe(0);
    const push = c.perTier.find((t) => t.tier === "PUSH");
    // 2 shown PUSH, 0 confirmed wrong → correctionRate 0 (not null: shown>0).
    expect(push).toMatchObject({ shown: 2, overriddenAway: 0, correctionRate: 0 });
  });

  it("ignores a same-tier affirmation (OVERRIDE to the shown tier is not a correction)", () => {
    const c = summarizeConfusion([row("PUSH", "OVERRIDE:PUSH")]);
    expect(c.confirmedOverrides).toBe(0);
    expect(c.matrix).toEqual({});
  });

  it("builds the full matrix across tiers (missed PUSH + over-suppressed SILENT)", () => {
    const c = summarizeConfusion([
      row("QUEUE", "OVERRIDE:PUSH"), // a miss: should have interrupted
      row("QUEUE", "OVERRIDE:PUSH"),
      row("SILENT", "OVERRIDE:QUEUE"), // over-suppression
      row("AUTO", "OVERRIDE:QUEUE"),
      row("PUSH", null),
    ]);
    expect(c.confirmedOverrides).toBe(4);
    expect(c.matrix).toEqual({
      QUEUE: { PUSH: 2 },
      SILENT: { QUEUE: 1 },
      AUTO: { QUEUE: 1 },
    });
    expect(c.perTier.find((t) => t.tier === "QUEUE")?.correctionRate).toBeCloseTo(2 / 2, 5);
    expect(c.perTier.find((t) => t.tier === "SILENT")?.correctionRate).toBeCloseTo(1 / 1, 5);
  });

  it("ignores unknown shownTier values (legacy/garbage)", () => {
    const c = summarizeConfusion([row("CALL", "OVERRIDE:PUSH")]);
    expect(c.total).toBe(1);
    expect(c.confirmedOverrides).toBe(0); // CALL is not a valid tier → skipped
  });
});
