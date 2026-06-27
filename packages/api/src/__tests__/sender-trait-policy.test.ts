import { describe, expect, it } from "vitest";
import {
  RECURRING_INTENT_VALUES,
  RELATIONSHIP_VALUES,
  validateTraitValue,
} from "../sender-trait-policy.js";

describe("validateTraitValue", () => {
  it("accepts an allowed relationship value", () => {
    expect(validateTraitValue("relationship", "investor")).toBe("investor");
  });

  it("accepts an allowed recurring_intent value", () => {
    expect(validateTraitValue("recurring_intent", "billing")).toBe("billing");
  });

  it("rejects a hallucinated value (returns null)", () => {
    expect(validateTraitValue("relationship", "frenemy")).toBeNull();
    expect(validateTraitValue("recurring_intent", "URGENT")).toBeNull();
  });

  it("rejects a non-string / missing value", () => {
    expect(validateTraitValue("relationship", undefined)).toBeNull();
    expect(validateTraitValue("relationship", 5)).toBeNull();
  });

  it("exposes the closed value sets", () => {
    expect(RELATIONSHIP_VALUES).toContain("unknown");
    expect(RECURRING_INTENT_VALUES).toContain("none");
  });
});
