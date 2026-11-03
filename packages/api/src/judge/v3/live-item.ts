/**
 * What the v3 live decision stores on AttentionItem (docs/design/attention-
 * engine-v3.md §3(5) "Live decision", step 5): the columns ranking reads and
 * the structured reasons clients render.
 */

import type { Prisma } from "@prisma/client";
import type { LiveDecision } from "./live-decision.js";
import type { ThreadTurn } from "./policy-types.js";
import { type PolicyReason, reason } from "./reasons.js";

/** AttentionItem.v3Decision. */
export interface V3DecisionJson {
  basis: LiveDecision["basis"];
  reasons: PolicyReason[];
  threadTurn: ThreadTurn | null;
}

export interface V3ItemFields {
  v3PolicyVersion: string;
  v3Decision: V3DecisionJson;
  v3Due: Date | null;
  v3Importance: number;
  heldAt: Date | null;
}

/** A budget hold: when, and the limit that was spent (null if unknown). */
export interface Hold {
  heldAt: Date;
  budget: number | null;
}

export function v3ItemFields(decision: LiveDecision, hold: Hold | null): V3ItemFields {
  const reasons = hold
    ? [reason("held_budget", { params: { budget: hold.budget } }), ...decision.reasons]
    : decision.reasons;
  return {
    v3PolicyVersion: decision.policyVersion,
    v3Decision: { basis: decision.basis, reasons, threadTurn: decision.threadTurn },
    v3Due: decision.due ? new Date(decision.due) : null,
    v3Importance: decision.importance,
    heldAt: hold?.heldAt ?? null,
  };
}

/** The Prisma write for these fields. */
export function v3Columns(fields: V3ItemFields) {
  return {
    v3PolicyVersion: fields.v3PolicyVersion,
    v3Decision: fields.v3Decision as unknown as Prisma.InputJsonValue,
    v3Due: fields.v3Due,
    v3Importance: fields.v3Importance,
    heldAt: fields.heldAt,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The budget recorded on a stored hold's reason, or null. */
export function heldBudgetOf(raw: unknown): number | null {
  if (!isRecord(raw) || !Array.isArray(raw.reasons)) return null;
  const held = raw.reasons.find((r) => isRecord(r) && r.code === "held_budget");
  const budget = isRecord(held) && isRecord(held.params) ? held.params.budget : null;
  return typeof budget === "number" ? budget : null;
}
