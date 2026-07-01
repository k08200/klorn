import { describe, expect, it, vi } from "vitest";
import type { ProposalCandidate } from "../ontology-proposals.js";
import {
  type ProposalStore,
  persistProposals,
  toAutoScoredOutcomes,
} from "../ontology-proposals-store.js";

function candidate(knob: string): ProposalCandidate {
  return {
    knob,
    currentValue: 0.7,
    proposedValue: 0.65,
    direction: "LOWER",
    evidence: {
      metric: "push.recallUpperBound",
      value: 0.5,
      target: 0.9,
      sampleSize: 50,
      windowDays: 30,
    },
  };
}

function fakeStore(open: Record<string, string>): ProposalStore & {
  created: ProposalCandidate[];
  updated: { id: string; c: ProposalCandidate }[];
  dismissedExcept: string[][];
} {
  const created: ProposalCandidate[] = [];
  const updated: { id: string; c: ProposalCandidate }[] = [];
  const dismissedExcept: string[][] = [];
  return {
    created,
    updated,
    dismissedExcept,
    findOpenByKnob: vi.fn(async (knob: string) => (open[knob] ? { id: open[knob] } : null)),
    updateOpen: vi.fn(async (id: string, c: ProposalCandidate) => {
      updated.push({ id, c });
    }),
    createOpen: vi.fn(async (c: ProposalCandidate) => {
      created.push(c);
    }),
    dismissOpenExcept: vi.fn(async (keep: readonly string[]) => {
      dismissedExcept.push([...keep]);
      return 0;
    }),
  };
}

describe("persistProposals", () => {
  it("creates a new OPEN row when none exists for the knob", async () => {
    const store = fakeStore({});
    const res = await persistProposals([candidate("tier.push.confidence")], store);
    expect(store.created).toHaveLength(1);
    expect(store.updated).toHaveLength(0);
    expect(res.written).toBe(1);
  });

  it("updates the existing OPEN row instead of stacking a duplicate", async () => {
    const store = fakeStore({ "tier.push.confidence": "row-1" });
    await persistProposals([candidate("tier.push.confidence")], store);
    expect(store.updated).toEqual([{ id: "row-1", c: candidate("tier.push.confidence") }]);
    expect(store.created).toHaveLength(0);
  });

  it("dismisses OPEN proposals whose knob is no longer proposed", async () => {
    const store = fakeStore({});
    await persistProposals(
      [candidate("tier.push.confidence"), candidate("tier.silent.reversibility")],
      store,
    );
    expect(store.dismissedExcept).toEqual([["tier.push.confidence", "tier.silent.reversibility"]]);
  });

  it("with no candidates, dismisses all OPEN (signal fully recovered)", async () => {
    const store = fakeStore({});
    const res = await persistProposals([], store);
    expect(store.created).toHaveLength(0);
    expect(store.dismissedExcept).toEqual([[]]);
    expect(res.written).toBe(0);
  });
});

describe("toAutoScoredOutcomes", () => {
  it("drops unconfirmed (null-outcome) rows — honest-by-design", () => {
    const rows = [
      { features: { confidence: 0.9 }, outcome: null },
      { features: { confidence: 0.8 }, outcome: "DISMISSED" },
    ];
    expect(toAutoScoredOutcomes(rows)).toEqual([{ confidence: 0.8, correct: true }]);
  });

  it("marks OVERRIDE:* outcomes as incorrect, terminal outcomes as correct", () => {
    const rows = [
      { features: { confidence: 0.7 }, outcome: "OVERRIDE:QUEUE" },
      { features: { confidence: 0.95 }, outcome: "OPENED" },
    ];
    expect(toAutoScoredOutcomes(rows)).toEqual([
      { confidence: 0.7, correct: false },
      { confidence: 0.95, correct: true },
    ]);
  });

  it("skips rows without a numeric confidence feature", () => {
    const rows = [
      { features: null, outcome: "DISMISSED" },
      { features: { confidence: "high" }, outcome: "DISMISSED" },
      { features: {}, outcome: "DISMISSED" },
      { features: { confidence: 0.6 }, outcome: "DISMISSED" },
    ];
    expect(toAutoScoredOutcomes(rows)).toEqual([{ confidence: 0.6, correct: true }]);
  });
});
