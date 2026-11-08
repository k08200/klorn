/**
 * Live PUSH interrupt budget (docs/design/attention-engine-v3.md §3(5)), used
 * by the v3 live decision (live-judge.ts) for users JUDGE_V3_POLICY covers,
 * before the item is written.
 *
 * The existing gates run first and spend no budget: the 6h recency rule, the
 * IMAP re-ingest skip and the 7-day dedupe (firewall-push.ts). A push that
 * would not ring anyway (the user's notification preferences, quiet hours or
 * focus block say no) spends nothing either, and neither does a sender the
 * user pinned to PUSH: a pin is the user's own rule and keeps precedence.
 *
 * Every other PUSH claims a slot by writing its bell row with dedupeKey
 * `interrupt:<local day>:<n>`; (userId, dedupeKey) is unique, so two concurrent
 * judgements can never both take the last slot. Strangers claim only above
 * the trusted reserve. With no slot left, the item is held: written as QUEUE
 * with heldAt and the held reason, and nothing is sent.
 *
 * MEETING notifications are not budgeted.
 */

import { HIDDEN_CLAIM_TYPE } from "../../agentcore/auto-reply-ledger-keys.js";
import { prisma } from "../../db.js";
import { escapeLikePattern } from "../../db-like.js";
import { evaluateNotificationGate } from "../../notify/notification-prefs.js";
import {
  claimInterruptSlot,
  interruptSlotPrefix,
  localDayKey,
  resolveUserInterruptBudget,
} from "./interrupt-budget.js";

/**
 * Stored in AttentionItem.tierReason for display (tier-reason-strings.ts). The
 * judge drops a model reason equal to a static key, so only the hold writes
 * it. Ranking trusts AttentionItem.heldAt, not this text.
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
  /** trusted: a VIP or someone the user wrote to, who may use the reserved slots. */
  opts: { pinned: boolean; trusted: boolean; now?: Date },
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
  return claimSlotWithRow(userId, row, now, opts.trusted);
}

async function writeRow(userId: string, row: BellRow): Promise<WrittenRow> {
  return prisma.notification.create({
    data: { userId, ...row },
    select: { id: true, createdAt: true },
  });
}

async function claimSlotWithRow(
  userId: string,
  row: BellRow,
  now: Date,
  trusted: boolean,
): Promise<PushAdmission> {
  const { dayKey, limit } = await budgetDayFor(userId, now);
  // Filled by the winning tryCreate (a holder, since TS does not track closure writes).
  const written: { row: WrittenRow | null } = { row: null };
  const claim = await claimInterruptSlot({
    dayKey,
    limit,
    trusted,
    usedSlots: async (prefix) => {
      const rows = await prisma.notification.findMany({
        where: { userId, dedupeKey: { startsWith: escapeLikePattern(prefix) } },
        select: { dedupeKey: true },
      });
      return rows.map((r) => Number((r.dedupeKey ?? "").slice(prefix.length)));
    },
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
 * A bad setting is logged once per process, not on every read: the Today
 * surfaces read the budget on every list and poll.
 */
const warned = new Set<string>();
const MAX_WARNED_KEYS = 1000;
function warnOnce(key: string, message: string): void {
  if (warned.has(key) || warned.size >= MAX_WARNED_KEYS) return;
  warned.add(key);
  console.warn(message);
}

/** The user's budget day (their local date) and daily limit. */
export async function budgetDayFor(
  userId: string,
  now: Date,
): Promise<{ dayKey: string; limit: number | null }> {
  const config = await prisma.automationConfig.findUnique({
    where: { userId },
    select: { timezone: true, interruptBudget: true },
  });
  const wanted = config?.timezone ?? DEFAULT_TIME_ZONE;
  const { dayKey, zone } = localDayKey(now, wanted);
  if (zone !== wanted) {
    warnOnce(
      `tz:${userId}`,
      `[PUSH-BUDGET] invalid timezone "${wanted}" for user ${userId}; counting the day in ${zone}`,
    );
  }
  const limit = resolveUserInterruptBudget(config?.interruptBudget ?? null, process.env, (raw) =>
    warnOnce(
      "budget-env",
      `[PUSH-BUDGET] ignoring invalid JUDGE_V3_PUSH_BUDGET="${raw}"; using the default`,
    ),
  );
  return { dayKey, limit };
}

/**
 * The day's interrupt budget for the Today surfaces: the user's limit, the
 * slots spent today (hidden rows included: clearing the bell does not hand
 * budget back) and the local day.
 */
export async function interruptBudgetStatus(
  userId: string,
  now: Date,
): Promise<{ limit: number | null; used: number; day: string }> {
  const { dayKey, limit } = await budgetDayFor(userId, now);
  const used = await prisma.notification.count({
    where: { userId, dedupeKey: { startsWith: escapeLikePattern(interruptSlotPrefix(dayKey)) } },
  });
  return { limit, used, day: dayKey };
}

/**
 * A slot was claimed, but a human or an agent changed the item before it was
 * written (doc §3(5), live decision step 7). Nothing is sent; the slot stays
 * spent, and the bell row is hidden like a cleared slot row.
 */
export async function hideClaimedBellRow(userId: string, notificationId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { type: HIDDEN_CLAIM_TYPE, isRead: true },
  });
}

/**
 * A slot was claimed, but writing the item failed, so nothing rang. The claim
 * is released (unlike a cleared bell, where the row is only hidden): the retry
 * must be able to claim the slot and ring, and must not find this row as
 * "already pushed".
 */
export async function releaseClaimedBellRow(userId: string, notificationId: string): Promise<void> {
  await prisma.notification.deleteMany({ where: { id: notificationId, userId } });
}
