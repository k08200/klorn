/**
 * The attention engine v3 fields read APIs add for a user under the policy
 * (docs/design/attention-engine-v3.md §3(5) "Reasons and API contract"):
 * each mail's `v3` block and the Today fields. Callers check
 * isJudgeV3PolicyEnabled first; for everyone else nothing here runs.
 */

import type { V3ItemBlock, V3TodayFields } from "@klorn/contract";
import { type InboxScope, listV3RowsByEmail, pageEmailIdsInLane } from "../email-lanes.js";
import { type V3ItemRow, v3ItemWire } from "./item-wire.js";
import { interruptBudgetStatus } from "./push-budget-gate.js";

/** A mail the judge has not reached yet: no decision, nothing held. */
const UNDECIDED: V3ItemRow = {
  tier: null,
  heldAt: null,
  isManualOverride: false,
  agentTierSetAt: null,
  v3PolicyVersion: null,
  v3Decision: null,
  v3Due: null,
};

/**
 * The `v3` block per mail, in list order. `rankFrom` is the 1-based rank of
 * the first mail when the list is a ranked QUEUE page, else null (no rank).
 */
export async function v3BlocksFor(
  userId: string,
  mails: ReadonlyArray<{ id: string; subject: string | null }>,
  rankFrom: number | null,
): Promise<Map<string, V3ItemBlock>> {
  const rows = await listV3RowsByEmail(
    userId,
    mails.map((m) => m.id),
  );
  return new Map(
    mails.map((mail, index) => [
      mail.id,
      v3ItemWire(rows.get(mail.id) ?? UNDECIDED, {
        rank: rankFrom === null ? null : rankFrom + index,
        subject: mail.subject,
      }),
    ]),
  );
}

/**
 * Today's fields: the day's interrupt budget, how much is in the QUEUE lane
 * (the same count the lane page shows, for the same inbox scope) and when the
 * ranks were computed.
 */
export async function v3TodayFields(
  userId: string,
  scope: InboxScope,
  rankedAt: Date,
): Promise<Required<V3TodayFields>> {
  const [interruptBudget, queue] = await Promise.all([
    interruptBudgetStatus(userId, rankedAt),
    pageEmailIdsInLane({ userId, lane: "QUEUE", scope, skip: 0, take: 0 }),
  ]);
  return { interruptBudget, queueTotal: queue.total, rankedAt: rankedAt.toISOString() };
}
