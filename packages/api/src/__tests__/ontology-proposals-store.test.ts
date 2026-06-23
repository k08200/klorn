import { describe, expect, it, vi } from "vitest";
import type { ProposalCandidate } from "../ontology-proposals.js";
import { type ProposalStore, persistProposals } from "../ontology-proposals-store.js";

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
