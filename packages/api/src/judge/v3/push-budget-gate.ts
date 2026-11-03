/**
 * Live PUSH interrupt budget (docs/design/attention-engine-v3.md §3(5)), used by
 * the firewall push path while JUDGE_V3_POLICY is on.
 *
 * The existing gates run first and spend no budget: the 6h recency rule, the
 * IMAP re-ingest skip and the 7-day dedupe (email-firewall.ts). A push that
 * would not ring anyway (the user's notification preferences, quiet hours or
 * focus block say no) spends nothing either, and neither does a sender the
 * user pinned to PUSH: a pin is the user's own rule and keeps precedence.
 *
 * Every other PUSH claims a slot by writing its bell row with dedupeKey
 * `interrupt:<local day>:<n>`; (userId, dedupeKey) is unique, so two concurrent
 * judgements can never both take the last slot. With no slot left, the item is
 * held: QUEUE, the held reason key, no notification.
 *
 * MEETING notifications are not budgeted.
 */

import { prisma } from "../../db.js";
import { escapeLikePattern } from "../../db-like.js";
import { evaluateNotificationGate } from "../../notify/notification-prefs.js";
import { NOT_AGENT_SET } from "../agent-tier.js";
import { claimInterruptSlot, localDayKey, resolveInterruptBudget } from "./interrupt-budget.js";

/**
 * Stored in AttentionItem.tierReason for display (tier-reason-strings.ts). The
 * judge drops a model reason equal to a static key, so only this path writes
 * it; P3 PR2 adds a dedicated held column as the marker the ranking trusts.
 */
export const HELD_REASON_KEY = "email.heldByInterruptBudget";

/** AutomationConfig.timezone's schema default, for a user with no config row. */
const DEFAULT_TIME_ZONE = "Asia/Seoul";

export interface BellRow {
  type: string;
  title: string;
  message: string;
}

type WrittenRow = { id: string; createdAt: Date };

export type PushAdmission =
  /** A budget slot was claimed with this bell row. */
  | { status: "admitted"; notification: WrittenRow }
  /** Written outside the budget: a pinned sender, or a push that will not ring. */
  | { status: "unbudgeted"; notification: WrittenRow; why: "pinned" | "will_not_ring" }
  | { status: "held"; limit: number | null };

const isUniqueViolation = (err: unknown): boolean =>
  (err as { code?: string } | null)?.code === "P2002";

/** Write the bell row, spending a budget slot when the push will actually ring. */
export async function admitPushNotification(
  userId: string,
  row: BellRow,
  opts: { pinned: boolean; now?: Date },
): Promise<PushAdmission> {
  const now = opts.now ?? new Date();
  if (opts.pinned)
    return { status: "unbudgeted", notification: await writeRow(userId, row), why: "pinned" };
  const gate = await evaluateNotificationGate(userId, "email_urgent", now);
  if (!gate.allowed) {
    return {
      status: "unbudgeted",
      notification: await writeRow(userId, row),
      why: "will_not_ring",
    };
  }
  return claimSlotWithRow(userId, row, now);
}

async function writeRow(userId: string, row: BellRow): Promise<WrittenRow> {
  return prisma.notification.create({
    data: { userId, ...row },
    select: { id: true, createdAt: true },
  });
}

async function claimSlotWithRow(userId: string, row: BellRow, now: Date): Promise<PushAdmission> {
  const config = await prisma.automationConfig.findUnique({
    where: { userId },
    select: { timezone: true },
  });
  const wanted = config?.timezone ?? DEFAULT_TIME_ZONE;
  const { dayKey, zone } = localDayKey(now, wanted);
  if (zone !== wanted) {
    console.warn(
      `[PUSH-BUDGET] invalid timezone "${wanted}" for user ${userId}; counting the day in ${zone}`,
    );
  }
  const limit = resolveInterruptBudget(process.env, (raw) =>
    console.warn(`[PUSH-BUDGET] ignoring invalid JUDGE_V3_PUSH_BUDGET="${raw}"; using the default`),
  );
  // Filled by the winning tryCreate (a holder, since TS does not track closure writes).
  const written: { row: WrittenRow | null } = { row: null };
  const claim = await claimInterruptSlot({
    dayKey,
    limit,
    countUsed: (prefix) =>
      prisma.notification.count({
        where: { userId, dedupeKey: { startsWith: escapeLikePattern(prefix) } },
      }),
    tryCreate: async (dedupeKey) => {
      try {
        written.row = await prisma.notification.create({
          data: { userId, ...row, dedupeKey },
          select: { id: true, createdAt: true },
        });
        return "created";
      } catch (err) {
        if (isUniqueViolation(err)) return "taken";
        throw err;
      }
    },
  });
  if (claim.status === "held" || written.row === null) return { status: "held", limit };
  return { status: "admitted", notification: written.row };
}

/**
 * Hold a PUSH email in QUEUE for the rest of the day. Guarded on the stored
 * tier and provenance, so a human or agent decision that landed meanwhile is
 * never overwritten. Returns whether the item was held.
 */
export async function holdEmailForInterruptBudget(
  userId: string,
  emailId: string,
): Promise<boolean> {
  const held = await prisma.attentionItem.updateMany({
    where: {
      userId,
      source: "EMAIL",
      sourceId: emailId,
      tier: "PUSH",
      isManualOverride: false,
      ...NOT_AGENT_SET,
    },
    data: { tier: "QUEUE", tierReason: HELD_REASON_KEY },
  });
  if (held.count === 0) return false;
  // Keep the outcome ledger truthful: the user was shown QUEUE, not PUSH.
  // decidedBy stays: it records which judge path scored the mail, and the
  // fallback repair sweep selects on it (fallback-rejudge.ts).
  await prisma.decisionLabel.updateMany({
    where: { userId, source: "EMAIL", sourceId: emailId },
    data: { shownTier: "QUEUE" },
  });
  return true;
}
