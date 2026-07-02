import { describe, expect, it } from "vitest";
import type { CandidateTrait } from "../sender-trait-policy.js";
import { type IncumbentTrait, resolveTraitUpsert } from "../sender-trait-store.js";

const challenger: CandidateTrait = {
  factKind: "relationship",
  factValue: "investor",
  confidence: 0.9,
  evidenceText: "We'd like to invest in your round.",
};

describe("resolveTraitUpsert", () => {
  it("creates when there is no incumbent", () => {
    const action = resolveTraitUpsert(null, challenger, "sig1");
    expect(action.type).toBe("create");
  });

  it("strengthens when the value matches", () => {
    const incumbent: IncumbentTrait = {
      factValue: "investor",
      observedCount: 2,
      status: "active",
    };
    const action = resolveTraitUpsert(incumbent, challenger, "sig2");
    expect(action.type).toBe("strengthen");
    if (action.type === "strengthen") {
      expect(action.observedCount).toBe(3);
      expect(action.sourceSig).toBe("sig2");
    }
  });

  it("no-ops (unchanged) when the value AND the sourceSig both match the incumbent", () => {
    // Idempotency contract: re-processing the same sample must not re-increment
    // observedCount. Without the sig check the weekly job double-counts.
    const incumbent: IncumbentTrait = {
      factValue: "investor",
      observedCount: 5,
      status: "active",
      sourceSig: "sig-same",
    };
    const action = resolveTraitUpsert(incumbent, challenger, "sig-same");
    expect(action.type).toBe("unchanged");
  });

  it("still strengthens when the value matches but the sourceSig is new evidence", () => {
    const incumbent: IncumbentTrait = {
      factValue: "investor",
      observedCount: 5,
      status: "active",
      sourceSig: "old-sig",
    };
    const action = resolveTraitUpsert(incumbent, challenger, "new-sig");
    expect(action.type).toBe("strengthen");
    if (action.type === "strengthen") {
      expect(action.observedCount).toBe(6);
    }
  });

  it("flags a conflict on a different value, never overwriting the incumbent", () => {
    const incumbent: IncumbentTrait = {
      factValue: "vendor",
      observedCount: 4,
      status: "active",
    };
    const action = resolveTraitUpsert(incumbent, challenger, "sig3");
    expect(action.type).toBe("conflict");
    if (action.type === "conflict") {
      expect(action.keepValue).toBe("vendor");
      expect(action.conflictValue).toBe("investor");
    }
  });
});
