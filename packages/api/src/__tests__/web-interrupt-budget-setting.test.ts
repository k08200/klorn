/**
 * Settings → Notifications, "Interruptions per day" (founder design N3,
 * 2026-11-08): the pure rules in
 * packages/web/src/app/settings/_sections/interrupt-budget-model.ts. The row
 * shows only when GET /api/automations carries the budget fields (users under
 * the v3 policy); the four choices map onto what PATCH accepts (1..max).
 */

import { describe, expect, it } from "vitest";
import {
  BUDGET_CHOICES,
  budgetSetting,
  choiceValue,
  selectedChoice,
} from "../../../web/src/app/settings/_sections/interrupt-budget-model";

const ON = { interruptBudget: null, interruptBudgetDefault: 5, interruptBudgetMax: 50 };

describe("budgetSetting", () => {
  it("is nothing when the server did not send the fields (policy off)", () => {
    expect(budgetSetting({})).toBeNull();
    expect(budgetSetting(null)).toBeNull();
    expect(budgetSetting({ interruptBudget: 5 })).toBeNull();
  });

  it("is nothing for a malformed max", () => {
    expect(budgetSetting({ ...ON, interruptBudgetMax: 0 })).toBeNull();
    expect(budgetSetting({ ...ON, interruptBudgetMax: 2.5 })).toBeNull();
  });

  it("reads the user's value, the system default and the max", () => {
    expect(budgetSetting(ON)).toEqual({ value: null, defaultLimit: 5, max: 50 });
    expect(budgetSetting({ ...ON, interruptBudget: 10 })).toEqual({
      value: 10,
      defaultLimit: 5,
      max: 50,
    });
  });
});

describe("selectedChoice", () => {
  it("offers 3, 5, 10 and no limit, in that order", () => {
    expect(BUDGET_CHOICES).toEqual([3, 5, 10, "none"]);
  });

  it("an unset value is the system default (5)", () => {
    expect(selectedChoice({ value: null, defaultLimit: 5, max: 50 })).toBe(5);
  });

  it("the server max reads as no limit", () => {
    expect(selectedChoice({ value: 50, defaultLimit: 5, max: 50 })).toBe("none");
  });

  it("an unlimited system default reads as no limit", () => {
    expect(selectedChoice({ value: null, defaultLimit: null, max: 50 })).toBe("none");
  });

  it("a value set elsewhere that is not a choice selects nothing", () => {
    expect(selectedChoice({ value: 7, defaultLimit: 5, max: 50 })).toBeNull();
  });
});

describe("choiceValue", () => {
  it("sends the number for a numbered choice", () => {
    expect(choiceValue(3, { value: null, defaultLimit: 5, max: 50 })).toBe(3);
  });

  it("sends the server max for no limit", () => {
    expect(choiceValue("none", { value: null, defaultLimit: 5, max: 50 })).toBe(50);
  });

  it("sends null (the unlimited system default) when the default already has no limit", () => {
    expect(choiceValue("none", { value: 3, defaultLimit: null, max: 50 })).toBeNull();
  });
});
