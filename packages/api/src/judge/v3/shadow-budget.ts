/**
 * Budget line for the v3 facts shadow. The shadow is ordinary background
 * work: createCompletion admits it only below (cap - JUDGE_BUDGET_RESERVE_CENTS),
 * so the judge reserve (#1442/#1517) keeps new-mail v2 judging alive. This
 * pre-check stops the shadow before it even builds a prompt, and keeps a floor
 * of its own when the reserve is off (self-host / unset), so the shadow can
 * never be what spends the v2 judge's last cents.
 */

import { checkCostGate } from "../../billing/cost-guard.js";
import { JUDGE_BUDGET_RESERVE_CENTS } from "../../config.js";

const DEFAULT_SHADOW_FLOOR_CENTS = 25;

export function shadowFloorCents(): number {
  const raw = Number(process.env.JUDGE_V3_SHADOW_FLOOR_CENTS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SHADOW_FLOOR_CENTS;
}

export interface GateView {
  allowed: boolean;
  remainingCents: number;
  capCents: number;
}

/** Pure: is there room for shadow work above the v2 judge's protected slice? */
export function shadowHeadroomOk(
  gate: GateView,
  opts: { floorCents: number; reserveCents: number },
): boolean {
  if (!gate.allowed) return false;
  if (gate.capCents <= 0) return true;
  // remainingCents is measured to (cap - reserve). The reserve already
  // protects that much; keep only the part of the floor it does not cover.
  const extra = Math.max(0, opts.floorCents - Math.max(0, opts.reserveCents));
  return gate.remainingCents > extra;
}

export async function shadowBudgetAllows(userId: string): Promise<boolean> {
  const gate = await checkCostGate(userId);
  return shadowHeadroomOk(gate, {
    floorCents: shadowFloorCents(),
    reserveCents: JUDGE_BUDGET_RESERVE_CENTS,
  });
}
