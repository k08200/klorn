/**
 * decision-metrics reader: the honest read path over the DecisionLabel ledger.
 *
 * The contract under test is "측정 not 주입": a null outcome is never counted
 * as "the firewall was right". PUSH recall is an UPPER bound (confirmed
 * escalations only), SILENT over-suppression a LOWER bound (confirmed rescues
 * only). These tests pin those semantics so a later refactor can't quietly
 * turn silence into agreement.
 */

import { describe, expect, it } from "vitest";
import {
  type DecisionRow,
  dailySummaryOf,
  summarizeDecisions,
  summarizeEngagementGrounding,
} from "../judge/decision-metrics.js";

// shownTier × outcome matrix exercising every classification branch.
const ROWS: DecisionRow[] = [
  { shownTier: "PUSH", outcome: null, decidedBy: "llm" }, // kept (presumed)
  { shownTier: "PUSH", outcome: "OVERRIDE:QUEUE", decidedBy: "sender-prior" }, // false PUSH
  { shownTier: "QUEUE", outcome: "OVERRIDE:PUSH", decidedBy: "llm" }, // confirmed miss
  { shownTier: "SILENT", outcome: "OVERRIDE:PUSH", decidedBy: "fast-path" }, // miss + rescue
  { shownTier: "SILENT", outcome: null, decidedBy: "fast-path" }, // muted, untouched
  { shownTier: "SILENT", outcome: "OVERRIDE:QUEUE", decidedBy: "sender-prior" }, // rescue
  { shownTier: "QUEUE", outcome: null, decidedBy: "llm" }, // untouched
  { shownTier: "QUEUE", outcome: "OVERRIDE:QUEUE", decidedBy: "llm" }, // same-tier no-op
];

describe("summarizeDecisions", () => {
  it("returns zeroed metrics and null rates for an empty ledger", () => {
    const m = summarizeDecisions([]);
    expect(m.total).toBe(0);
    expect(m.acted).toBe(0);
    expect(m.push.recallUpperBound).toBeNull();
    expect(m.silent.overSuppressionRate).toBeNull();
    expect(m.overrideRate).toBeNull();
    expect(m.byDecidedBy).toEqual([]);
  });

  it("counts acted vs open without treating null as agreement", () => {
    const m = summarizeDecisions(ROWS);
    expect(m.total).toBe(8);
    expect(m.acted).toBe(5); // 4 overrides + 1 same-tier override
    expect(m.open).toBe(3);
  });

  it("treats only different-tier overrides as corrections", () => {
    const m = summarizeDecisions(ROWS);
    expect(m.corrections).toBe(4); // same-tier OVERRIDE:QUEUE on a QUEUE row excluded
    expect(m.overrideRate).toBeCloseTo(4 / 8);
  });

  it("reports PUSH recall as an upper bound from confirmed escalations only", () => {
    const m = summarizeDecisions(ROWS);
    expect(m.push.shown).toBe(2);
    expect(m.push.keptPresumed).toBe(1);
    expect(m.push.overriddenDown).toBe(1); // confirmed false PUSH
    expect(m.push.escalatedFromLower).toBe(2); // confirmed misses (QUEUE+SILENT → PUSH)
    expect(m.push.recallUpperBound).toBeCloseTo(1 / 3); // kept / (kept + missed)
  });

  it("reports SILENT over-suppression as a lower bound from confirmed rescues", () => {
    const m = summarizeDecisions(ROWS);
    expect(m.silent.shown).toBe(3);
    expect(m.silent.rescued).toBe(2);
    expect(m.silent.overSuppressionRate).toBeCloseTo(2 / 3);
  });

  it("groups corrections by deciding path so prior-bypass over-suppression is visible", () => {
    const m = summarizeDecisions(ROWS);
    const prior = m.byDecidedBy.find((d) => d.decidedBy === "sender-prior");
    expect(prior).toEqual({
      decidedBy: "sender-prior",
      total: 2,
      corrections: 2,
      correctionRate: 1,
    });
    const llm = m.byDecidedBy.find((d) => d.decidedBy === "llm");
    expect(llm?.total).toBe(4);
    expect(llm?.corrections).toBe(1);
  });

  it("counts a same-tier PUSH affirmation as kept, never as a correction", () => {
    // A user re-dragging an already-PUSH item to PUSH affirms the interrupt;
    // it must not orphan the row out of the recall denominator.
    const m = summarizeDecisions([
      { shownTier: "PUSH", outcome: "OVERRIDE:PUSH", decidedBy: "llm" },
    ]);
    expect(m.push.shown).toBe(1);
    expect(m.push.keptPresumed).toBe(1);
    expect(m.push.overriddenDown).toBe(0);
    expect(m.corrections).toBe(0);
    expect(m.push.recallUpperBound).toBe(1);
  });

  it("buckets a missing decidedBy under 'unknown'", () => {
    const m = summarizeDecisions([{ shownTier: "QUEUE", outcome: null }]);
    expect(m.byDecidedBy).toEqual([
      { decidedBy: "unknown", total: 1, corrections: 0, correctionRate: 0 },
    ]);
  });
});

describe("dailySummaryOf", () => {
  it("projects the bounded headline for the drift snapshot", () => {
    const summary = dailySummaryOf(summarizeDecisions(ROWS));
    expect(summary).toEqual({
      total: 8,
      acted: 5,
      recallUpperBound: 1 / 3,
      overSuppressionRate: 2 / 3,
      overrideRate: 0.5,
      pushShown: 2,
      silentShown: 3,
    });
  });
});

describe("summarizeEngagementGrounding", () => {
  // Mix of engagement kinds, tiers, and outcomes — plus non-grounded rows that
  // must be ignored entirely.
  const G_ROWS: DecisionRow[] = [
    { shownTier: "PUSH", outcome: null, engagementKind: "DIRECT" }, // fired, kept
    { shownTier: "QUEUE", outcome: "OVERRIDE:PUSH", engagementKind: "DIRECT" }, // fired, corrected
    { shownTier: "QUEUE", outcome: "OVERRIDE:QUEUE", engagementKind: "PROPAGATED" }, // fired, same-tier no-op
    { shownTier: "PUSH", outcome: null, engagementKind: "PROPAGATED" }, // fired, kept
    { shownTier: "SILENT", outcome: null, engagementKind: null }, // NOT grounded — ignored
    { shownTier: "PUSH", outcome: "OVERRIDE:SILENT" }, // no engagementKind field — ignored
  ];

  it("counts only grounded rows, split by kind and shown tier", () => {
    const m = summarizeEngagementGrounding(G_ROWS);
    expect(m.total).toBe(4);
    expect(m.direct).toBe(2);
    expect(m.propagated).toBe(2);
    expect(m.byTier).toEqual({ PUSH: 2, QUEUE: 2 });
  });

  it("uses confirmed tier-moving overrides for the correction rate (same-tier is a no-op)", () => {
    const m = summarizeEngagementGrounding(G_ROWS);
    expect(m.acted).toBe(2); // the two OVERRIDE rows
    expect(m.corrections).toBe(1); // only QUEUE→PUSH moved; QUEUE→QUEUE didn't
    expect(m.correctionRate).toBe(0.5);
  });

  it("is all-zero and null-rate before the flag ever fires (no grounded rows)", () => {
    const m = summarizeEngagementGrounding([
      { shownTier: "PUSH", outcome: null },
      { shownTier: "SILENT", outcome: "OVERRIDE:PUSH", engagementKind: null },
    ]);
    expect(m).toEqual({
      total: 0,
      direct: 0,
      propagated: 0,
      byTier: {},
      acted: 0,
      corrections: 0,
      correctionRate: null,
    });
  });
});
