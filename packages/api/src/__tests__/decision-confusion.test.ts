import { describe, expect, it } from "vitest";
import { type DecisionRow, summarizeConfusion } from "../decision-metrics.js";

const row = (shownTier: string, outcome: string | null): DecisionRow => ({ shownTier, outcome });

describe("summarizeConfusion (per-tier real accuracy from confirmed overrides)", () => {
  it("is empty on no rows", () => {
    const c = summarizeConfusion([]);
    expect(c.total).toBe(0);
    expect(c.confirmedOverrides).toBe(0);
    expect(c.confirmedCorrect).toBe(0);
    expect(c.matrix).toEqual({});
    expect(
      c.perTier.every(
        (t) =>
          t.shown === 0 &&
          t.correctionRate === null &&
          t.confirmedCorrect === 0 &&
          t.confirmedErrorRate === null,
      ),
    ).toBe(true);
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

  // ── CONFIRM: explicit agreement as positive ground truth ────────────────
  // A user CONFIRM ("CONFIRM:<tier>" at the shown tier) is the counterpart to an
  // override: the ONLY positive ground truth in the ledger. It turns a bounded
  // correctionRate (over all shown, incl. silence) into a point estimate over
  // rows the user actually labelled — without inferring correctness from silence.

  it("counts a CONFIRM as positive ground truth, not an override or a matrix move", () => {
    const c = summarizeConfusion([row("PUSH", "CONFIRM:PUSH")]);
    expect(c.confirmedOverrides).toBe(0);
    expect(c.confirmedCorrect).toBe(1);
    expect(c.matrix).toEqual({}); // a confirm is not a move
    const push = c.perTier.find((t) => t.tier === "PUSH");
    expect(push).toMatchObject({
      shown: 1,
      overriddenAway: 0,
      confirmedCorrect: 1,
      correctionRate: 0, // lower bound over all shown
      confirmedErrorRate: 0, // point estimate: 0 wrong of 1 labelled
    });
  });

  it("confirmedErrorRate is a point estimate over labelled rows; correctionRate stays a lower bound", () => {
    const rows = [
      row("PUSH", "OVERRIDE:QUEUE"), // 1 confirmed wrong
      row("PUSH", "CONFIRM:PUSH"), // 3 confirmed right
      row("PUSH", "CONFIRM:PUSH"),
      row("PUSH", "CONFIRM:PUSH"),
      row("PUSH", null), // 6 unlabelled (silence — never counted)
      row("PUSH", null),
      row("PUSH", null),
      row("PUSH", null),
      row("PUSH", null),
      row("PUSH", null),
    ];
    const c = summarizeConfusion(rows);
    expect(c.confirmedOverrides).toBe(1);
    expect(c.confirmedCorrect).toBe(3);
    const push = c.perTier.find((t) => t.tier === "PUSH");
    expect(push?.shown).toBe(10);
    expect(push?.overriddenAway).toBe(1);
    expect(push?.confirmedCorrect).toBe(3);
    // Lower bound: 1 wrong / 10 shown = 0.1 (unchanged, honest over silence).
    expect(push?.correctionRate).toBeCloseTo(0.1, 5);
    // Point estimate: 1 wrong / 4 labelled = 0.25 (the number worth trending).
    expect(push?.confirmedErrorRate).toBeCloseTo(0.25, 5);
  });

  it("confirmedErrorRate is null (honest unknown) when the tier has zero explicit labels", () => {
    const c = summarizeConfusion([row("PUSH", null)]);
    const push = c.perTier.find((t) => t.tier === "PUSH");
    expect(push?.shown).toBe(1);
    expect(push?.correctionRate).toBe(0); // 0 confirmed wrong of 1 shown
    expect(push?.confirmedErrorRate).toBeNull(); // but nothing was actually labelled
  });

  it("does not count a CONFIRM naming a different tier than shown (contradictory data)", () => {
    const c = summarizeConfusion([row("PUSH", "CONFIRM:QUEUE")]);
    expect(c.confirmedCorrect).toBe(0);
    expect(c.confirmedOverrides).toBe(0);
    const push = c.perTier.find((t) => t.tier === "PUSH");
    expect(push).toMatchObject({ shown: 1, confirmedCorrect: 0, overriddenAway: 0 });
  });
});
