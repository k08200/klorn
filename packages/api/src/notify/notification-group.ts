/**
 * The notification center group of one bell row (NC1, contract
 * NotificationGroup). Pure; the first rule that matches wins:
 *
 *  1. done   the row is read; or its mail's item is RESOLVED / DISMISSED; or
 *            its approval (PendingAction) is no longer PENDING.
 *  2. later  its mail's item is SNOOZED until a time still ahead: the user
 *            said "later", and that outranks every rule below.
 *  3. reply  its mail needs a reply not yet sent through Klorn
 *            (mail/reply-state.ts replyStateOf === "needsReply").
 *  4. now    its mail is in the PUSH lane (retired CALL folds to PUSH) and
 *            inside Today's PUSH window: received in the last 72 hours
 *            (judge/today-push-window.ts, LOCKED 2026-10-23). A row whose
 *            lane is unknown is never "now".
 *  5. today  in the user's local calendar day: a MEETING mail whose row was
 *            written today, a mail whose v3 ask is due today (v3Due), or a
 *            meeting / calendar / reminder row written today; or an approval
 *            still PENDING (it waits on the user now).
 *  6. later  everything else: older or quieter mail, briefings, digests.
 */

import type { NotificationGroup } from "@klorn/contract";
import { toLiveTier } from "../judge/tiers.js";
import { isInTodayPushWindow } from "../judge/today-push-window.js";
import { localDayKey } from "../judge/v3/interrupt-budget.js";
import { replyStateOf } from "../mail/reply-state.js";

export interface GroupInput {
  isRead: boolean;
  /** Notification.type */
  type: string;
  createdAt: Date;
  pendingActionStatus: string | null;
  /** The row's mail's attention item, when the row names a mail that has one. */
  item: {
    tier: string | null;
    status: string;
    v3Due: Date | null;
    snoozedUntil: Date | null;
  } | null;
  /** The row's mail, when the row names one of the user's mails. */
  email: {
    receivedAt: Date;
    needsReply: boolean;
    repliedAt: Date | null;
  } | null;
}

export interface GroupContext {
  now: Date;
  /** IANA zone of the user's day. Read only when needsLocalDay(row). */
  timeZone: string;
}

const CLOSED_ITEM_STATUSES = new Set(["RESOLVED", "DISMISSED"]);
const PENDING = "PENDING";
/** Rows that are about a moment: a meeting alert, a calendar change, a reminder firing. */
const DAY_TYPES = new Set(["meeting", "calendar", "reminder"]);

function laneOf(input: GroupInput): string | null {
  return input.item?.tier ? toLiveTier(input.item.tier) : null;
}

function isDone(input: GroupInput): boolean {
  if (input.isRead) return true;
  if (input.item && CLOSED_ITEM_STATUSES.has(input.item.status)) return true;
  return input.pendingActionStatus !== null && input.pendingActionStatus !== PENDING;
}

function isSnoozed(input: GroupInput, now: Date): boolean {
  const item = input.item;
  return (
    item?.status === "SNOOZED" &&
    item.snoozedUntil !== null &&
    item.snoozedUntil.getTime() > now.getTime()
  );
}

function needsReply(input: GroupInput): boolean {
  return input.email !== null && replyStateOf(input.email) === "needsReply";
}

function isNow(input: GroupInput, now: Date): boolean {
  if (laneOf(input) !== "PUSH") return false;
  return isInTodayPushWindow(input.email?.receivedAt ?? null, input.createdAt, now);
}

/** The today-rule inputs that depend on the calendar day. */
function dayDependent(input: GroupInput): Date[] {
  const dates: Date[] = [];
  if (laneOf(input) === "MEETING" || DAY_TYPES.has(input.type)) dates.push(input.createdAt);
  if (input.item?.v3Due) dates.push(input.item.v3Due);
  return dates;
}

/**
 * Whether grouping this row reads the user's local day. False means the zone
 * passed to notificationGroup is never consulted, so a caller can skip
 * loading it.
 */
export function needsLocalDay(input: GroupInput): boolean {
  if (isDone(input) || input.pendingActionStatus === PENDING) return false;
  return dayDependent(input).length > 0;
}

function isToday(input: GroupInput, ctx: GroupContext): boolean {
  if (input.pendingActionStatus === PENDING) return true;
  const dates = dayDependent(input);
  if (dates.length === 0) return false;
  const today = localDayKey(ctx.now, ctx.timeZone).dayKey;
  return dates.some((d) => localDayKey(d, ctx.timeZone).dayKey === today);
}

export function notificationGroup(input: GroupInput, ctx: GroupContext): NotificationGroup {
  if (isDone(input)) return "done";
  if (isSnoozed(input, ctx.now)) return "later";
  if (needsReply(input)) return "reply";
  if (isNow(input, ctx.now)) return "now";
  if (isToday(input, ctx)) return "today";
  return "later";
}
