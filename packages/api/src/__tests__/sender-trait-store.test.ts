import { describe, expect, it } from "vitest";
import { resolveTraitUpsert, type IncumbentTrait } from "../sender-trait-store.js";
import type { CandidateTrait } from "../sender-trait-policy.js";

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
