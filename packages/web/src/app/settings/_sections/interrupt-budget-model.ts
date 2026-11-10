/**
 * "Interruptions per day" (founder design N3, 2026-11-08) — the pure half.
 * GET /api/automations sends `interruptBudget`, `interruptBudgetDefault` and
 * `interruptBudgetMax` only for a user under the attention policy (the same
 * check PATCH uses to accept the value), so the row exists only when the
 * server will honour it. No React, so the api vitest suite pins it
 * (packages/api/src/__tests__/web-interrupt-budget-setting.test.ts).
 */

/** The four choices, in display order. */
export const BUDGET_CHOICES = [3, 5, 10, "none"] as const;
export type BudgetChoice = (typeof BUDGET_CHOICES)[number];

export interface BudgetSetting {
  /** The user's own limit; null = the system default. */
  value: number | null;
  /** The system default the null value means; null = no limit. */
  defaultLimit: number | null;
  /** The largest value PATCH accepts. */
  max: number;
}

interface BudgetFields {
  interruptBudget?: number | null;
  interruptBudgetDefault?: number | null;
  interruptBudgetMax?: number;
}

const isPositiveInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0;

export function budgetSetting(config: BudgetFields | null | undefined): BudgetSetting | null {
  if (!config || !isPositiveInt(config.interruptBudgetMax)) return null;
  return {
    value: isPositiveInt(config.interruptBudget) ? config.interruptBudget : null,
    defaultLimit: isPositiveInt(config.interruptBudgetDefault)
      ? config.interruptBudgetDefault
      : null,
    max: config.interruptBudgetMax,
  };
}

/**
 * The choice the user's limit reads as: the default when unset; the server
 * max (or an unlimited default) as no limit; a value set elsewhere that is
 * none of the four selects nothing.
 */
export function selectedChoice(setting: BudgetSetting): BudgetChoice | null {
  const limit = setting.value ?? setting.defaultLimit;
  if (limit === null || limit >= setting.max) return "none";
  return BUDGET_CHOICES.find((choice) => choice === limit) ?? null;
}

/**
 * What PATCH gets for a choice. The server has no per-user "unlimited": no
 * limit is the largest value it accepts — or null when the system default
 * itself has no limit.
 */
export function choiceValue(choice: BudgetChoice, setting: BudgetSetting): number | null {
  if (choice !== "none") return choice;
  return setting.defaultLimit === null ? null : setting.max;
}
