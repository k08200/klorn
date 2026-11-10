/**
 * Route-facing outcome stamps: what a user did to a mail or attention item,
 * written to their DecisionLabel row so lane quality can be measured
 * (scripts/lane-quality.ts).
 *
 * Every helper is fire-and-forget. The route calls it after its action
 * succeeded and returns without waiting: a ledger write must never fail or
 * slow the user's request (the prod pool can queue a query for seconds).
 * Nothing here throws or rejects; a failure is logged through the same
 * console + Sentry path as the rest of the ledger.
 *
 * Call these from user-initiated routes only. Agent, auto-reply and sync
 * paths act without the user and must not stamp.
 */

import { prisma } from "../db.js";
import { captureError } from "../sentry.js";
import {
  type AttentionSourceName,
  type EngagementOutcome,
  stampDecisionOutcome,
  stampDecisionOutcomes,
} from "./decision-label.js";

/** Longest id kept in a log line: `ref` can be model-written (an approved reply). */
const MAX_LOGGED_REF = 64;

function logLookupError(op: string, ref: string, err: unknown): void {
  const shown = JSON.stringify(ref.slice(0, MAX_LOGGED_REF));
  console.warn(`[user-outcome] ${op} failed for ${shown}`, err);
  captureError(err, { tags: { area: "decision-label", op }, extra: { ref: shown } });
}

/** Stamp an EMAIL ledger row (sourceId = EmailMessage.id). */
export function noteEmailOutcome(
  userId: string,
  emailId: string,
  outcome: EngagementOutcome,
): void {
  void stampDecisionOutcome(userId, "EMAIL", emailId, outcome);
}

/** Bulk form for multi-select actions: one query. */
export function noteEmailOutcomes(
  userId: string,
  emailIds: readonly string[],
  outcome: EngagementOutcome,
): void {
  void stampDecisionOutcomes(userId, "EMAIL", emailIds, outcome);
}

/**
 * Stamp the ledger row behind an AttentionItem id. The item is looked up
 * within the user's own items, so a foreign id stamps nothing.
 */
export function noteAttentionItemOutcome(
  userId: string,
  itemId: string,
  outcome: EngagementOutcome,
): void {
  void (async () => {
    try {
      const item = await prisma.attentionItem.findFirst({
        where: { id: itemId, userId },
        select: { source: true, sourceId: true },
      });
      if (!item) return;
      await stampDecisionOutcome(
        userId,
        item.source as AttentionSourceName,
        item.sourceId,
        outcome,
      );
    } catch (err) {
      logLookupError("stamp-item", itemId, err);
    }
  })();
}

/**
 * Stamp REPLIED on the mail a reply answered, but only if the send actually
 * went out: markEmailReplied sets EmailMessage.repliedAt on success only, so
 * a repliedAt at or after `since` (when the user approved) is the proof.
 * `ref` is the EmailMessage id or its gmailId, as the send tool accepts.
 */
export function noteReplyIfSent(userId: string, ref: string, since: Date): void {
  void (async () => {
    try {
      const email = await prisma.emailMessage.findFirst({
        where: { userId, OR: [{ id: ref }, { gmailId: ref }], repliedAt: { gte: since } },
        select: { id: true },
      });
      if (!email) return;
      await stampDecisionOutcome(userId, "EMAIL", email.id, "REPLIED");
    } catch (err) {
      logLookupError("stamp-reply", ref, err);
    }
  })();
}
