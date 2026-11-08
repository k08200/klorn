/**
 * "Interruptions per day" (founder design N3, 2026-11-08) — the pure half.
 * GET /api/automations sends `interruptBudget`, `interruptBudgetDefault` and
 * `interruptBudgetMax` only for a user under the attention policy (the same
 * check PATCH uses), so the row exists only when the server honours it.
 * Mirrors packages/web/src/app/settings/_sections/interrupt-budget-model.ts.
 */

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

/** The choice the limit reads as; the max (or an unlimited default) is no limit. */
export function selectedChoice(setting: BudgetSetting): BudgetChoice | null {
  const limit = setting.value ?? setting.defaultLimit;
  if (limit === null || limit >= setting.max) return "none";
  return BUDGET_CHOICES.find((choice) => choice === limit) ?? null;
}

/** What PATCH gets: no limit is the server max, or null when the default has none. */
export function choiceValue(choice: BudgetChoice, setting: BudgetSetting): number | null {
  if (choice !== "none") return choice;
  return setting.defaultLimit === null ? null : setting.max;
}

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown"]);
const PREV_KEYS = new Set(["ArrowLeft", "ArrowUp"]);

/** The choice an arrow, Home or End key moves to (wrapping); null for other keys. */
export function nextChoice(key: string, current: BudgetChoice | null): BudgetChoice | null {
  const last = BUDGET_CHOICES.length - 1;
  const from = current === null ? -1 : BUDGET_CHOICES.indexOf(current);
  const at = (index: number): BudgetChoice | null => BUDGET_CHOICES[index] ?? null;
  if (NEXT_KEYS.has(key)) return at((from + 1) % BUDGET_CHOICES.length);
  if (PREV_KEYS.has(key)) return at(from <= 0 ? last : from - 1);
  if (key === "Home") return at(0);
  if (key === "End") return at(last);
  return null;
}
