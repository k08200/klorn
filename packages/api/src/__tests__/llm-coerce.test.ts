import { describe, expect, it } from "vitest";
import {
  asBoundedNumber,
  asEnum,
  asString,
  asStringArray,
  asUnitInterval,
  isNonFinitePresent,
} from "../llm/llm-coerce.js";

describe("asEnum", () => {
  const TIERS = ["high", "medium", "low"] as const;

  it("returns the value when it is an allowed member", () => {
    expect(asEnum("high", TIERS, "low")).toBe("high");
  });

  it("falls back on a hallucinated enum value", () => {
    expect(asEnum("urgent", TIERS, "low")).toBe("low");
  });

  it("falls back on a non-string / missing value", () => {
    expect(asEnum(1, TIERS, "low")).toBe("low");
    expect(asEnum(undefined, TIERS, "low")).toBe("low");
    expect(asEnum(null, TIERS, "low")).toBe("low");
    expect(asEnum({}, TIERS, "low")).toBe("low");
  });
});

describe("asBoundedNumber / asUnitInterval", () => {
  it("passes a valid in-range number through", () => {
    expect(asUnitInterval(0.7)).toBe(0.7);
    expect(asBoundedNumber(50, 0, 100, 0)).toBe(50);
  });

  it("accepts a numeric string", () => {
    expect(asUnitInterval("0.5")).toBe(0.5);
    expect(asBoundedNumber("50", 0, 100, 0)).toBe(50);
  });

  it("clamps an out-of-range value", () => {
    expect(asUnitInterval(1.5)).toBe(1);
    expect(asUnitInterval(-2)).toBe(0);
    expect(asBoundedNumber(150, 0, 100, 0)).toBe(100);
  });

  it("collapses NaN / Infinity / garbage to fallback — no NaN propagation", () => {
    expect(asUnitInterval(Number.NaN)).toBe(0);
    expect(asUnitInterval("abc")).toBe(0);
    expect(asUnitInterval(undefined)).toBe(0);
    expect(asUnitInterval(Number.POSITIVE_INFINITY)).toBe(0);
    expect(asUnitInterval({}, 0.25)).toBe(0.25);
  });
});

describe("asStringArray", () => {
  it("keeps only the string members", () => {
    expect(asStringArray(["a", 1, "b", null, {}])).toEqual(["a", "b"]);
  });

  it("returns [] for non-arrays", () => {
    expect(asStringArray("nope")).toEqual([]);
    expect(asStringArray(undefined)).toEqual([]);
    expect(asStringArray({})).toEqual([]);
  });

  it("caps length when a max is given", () => {
    expect(asStringArray(["a", "b", "c"], 2)).toEqual(["a", "b"]);
  });
});

describe("asString", () => {
  it("passes strings and falls back otherwise", () => {
    expect(asString("hi")).toBe("hi");
    expect(asString(5, "x")).toBe("x");
    expect(asString(undefined)).toBe("");
  });
});

describe("isNonFinitePresent", () => {
  it("is false when the value is absent", () => {
    expect(isNonFinitePresent(undefined)).toBe(false);
    expect(isNonFinitePresent(null)).toBe(false);
  });

  it("is false when the value is a finite number or numeric string", () => {
    expect(isNonFinitePresent(0.5)).toBe(false);
    expect(isNonFinitePresent(0)).toBe(false);
    expect(isNonFinitePresent("0.5")).toBe(false);
  });

  it("is true when present but non-numeric / NaN", () => {
    expect(isNonFinitePresent("abc")).toBe(true);
    expect(isNonFinitePresent(Number.NaN)).toBe(true);
    expect(isNonFinitePresent({})).toBe(true);
  });
});
