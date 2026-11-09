import { describe, expect, it } from "vitest";
import {
  BUDGET_CHOICES,
  budgetSetting,
  choiceValue,
  nextChoice,
  selectedChoice,
} from "./interrupt-budget-model";

// "Interruptions per day" (founder design N3, 2026-11-08). The server sends
// the budget fields only for a user under the attention policy.
const ON = { interruptBudget: null, interruptBudgetDefault: 5, interruptBudgetMax: 50 };

describe("budgetSetting", () => {
  it("is nothing without the fields (policy off: no row at all)", () => {
    expect(budgetSetting({})).toBeNull();
    expect(budgetSetting(undefined)).toBeNull();
    expect(budgetSetting({ interruptBudget: 5 })).toBeNull();
  });

  it("reads value, default and max", () => {
    expect(budgetSetting(ON)).toEqual({ value: null, defaultLimit: 5, max: 50 });
  });
});

describe("selectedChoice / choiceValue", () => {
  it("offers 3, 5, 10 and no limit", () => {
    expect(BUDGET_CHOICES).toEqual([3, 5, 10, "none"]);
  });

  it("unset is the default 5; the max is no limit; an odd value selects nothing", () => {
    expect(selectedChoice({ value: null, defaultLimit: 5, max: 50 })).toBe(5);
    expect(selectedChoice({ value: 50, defaultLimit: 5, max: 50 })).toBe("none");
    expect(selectedChoice({ value: 7, defaultLimit: 5, max: 50 })).toBeNull();
  });

  it("no limit sends the server max (no per-user unlimited exists)", () => {
    expect(choiceValue("none", { value: null, defaultLimit: 5, max: 50 })).toBe(50);
    expect(choiceValue(10, { value: null, defaultLimit: 5, max: 50 })).toBe(10);
    expect(choiceValue("none", { value: 3, defaultLimit: null, max: 50 })).toBeNull();
  });
});

describe("nextChoice (radiogroup arrow keys)", () => {
  it("moves and wraps, Home/End jump, other keys do nothing", () => {
    expect(nextChoice("ArrowRight", 5)).toBe(10);
    expect(nextChoice("ArrowDown", "none")).toBe(3);
    expect(nextChoice("ArrowLeft", 3)).toBe("none");
    expect(nextChoice("Home", 10)).toBe(3);
    expect(nextChoice("End", 3)).toBe("none");
    expect(nextChoice("ArrowRight", null)).toBe(3);
    expect(nextChoice("Enter", 5)).toBeNull();
  });
});
