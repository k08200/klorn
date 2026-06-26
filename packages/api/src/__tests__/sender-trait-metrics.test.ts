import { describe, expect, it } from "vitest";
import { summarizeTraits, type TraitRow } from "../sender-trait-metrics.js";

const rows: TraitRow[] = [
  { sender: "a@x.com", factKind: "relationship", status: "active", confidence: 0.9 },
  { sender: "a@x.com", factKind: "recurring_intent", status: "active", confidence: 0.8 },
  { sender: "b@x.com", factKind: "relationship", status: "conflicted", confidence: 0.5 },
];

describe("summarizeTraits", () => {
  it("computes coverage over the active-sender universe", () => {
    const m = summarizeTraits(rows, 4); // 4 active senders this window
    expect(m.sendersWithTrait).toBe(2);
    expect(m.coverage).toBeCloseTo(2 / 4);
  });

  it("computes the conflict rate over (sender,kind) rows", () => {
    const m = summarizeTraits(rows, 4);
    expect(m.totalTraits).toBe(3);
    expect(m.conflicted).toBe(1);
    expect(m.conflictRate).toBeCloseTo(1 / 3);
  });

  it("buckets confidence (high = >=0.8, mid = >=0.5, low = <0.5)", () => {
    const m = summarizeTraits(rows, 4);
    expect(m.confidenceBuckets.high).toBe(2); // 0.9 and 0.8
    expect(m.confidenceBuckets.mid).toBe(1); // 0.5
    expect(m.confidenceBuckets.low).toBe(0);
  });

  it("never divides by zero", () => {
    const m = summarizeTraits([], 0);
    expect(m.coverage).toBe(0);
    expect(m.conflictRate).toBe(0);
  });
});
