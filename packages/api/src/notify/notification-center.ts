/**
 * Notification center reads (NC1; wire types in @klorn/contract
 * notification-center.ts).
 *
 * enrichNotifications adds the optional lane / reason / held / group to a
 * page of bell rows. A row about a mail (sourceEmailId) is joined to the
 * user's AttentionItem(userId, source EMAIL, sourceId = sourceEmailId) and
 * EmailMessage, always scoped by userId, so a row naming another user's mail
 * enriches to nothing. A fixed number of queries per page, whatever its size:
 * items and mails in one batch each, at most one body read for policy-v3
 * quote checks (notification-reason.ts), and the reader's language and the
 * user's timezone only when a row needs them.
 *
 * notificationDelivery answers where one bell row's alert landed, from the
 * per-channel lifecycle rows (PushDeliveryLog, delivery-lifecycle.ts). A
 * delivery row belongs to the bell row when it names it:
 *   - bellNotificationId = the row: web push, FCM, APNs and Telegram rows of
 *     a push rung for that row (firewall PUSH / MEETING, urgent sweep,
 *     quiet-hours summary of one mail);
 *   - notificationId = the row: pushes that pass it (non-mail pushes), and
 *     the Windows app's receipts, which key on the bell row id;
 *   - the Mac app's receipt for the row's mail item: it keys its banner on
 *     the AttentionItem id (dedupe key desktop:<user>:mac:attention_item:<id>).
 * notificationId stays NULL for firewall pushes by design (phone escalation
 * keys on it), which is why bellNotificationId exists. Only rows created from
 * the bell row's creation on count (with a minute of slack), which also
 * bounds the read to the (userId, createdAt) index.
 */

import type {
  DeliveredState,
  DeliveryChannelName,
  NotificationBudget,
  NotificationDelivery,
  NotificationRow,
} from "@klorn/contract";
import { HIDDEN_CLAIM_TYPE } from "../agentcore/auto-reply-ledger-keys.js";
import type { NotificationDTO } from "../background.js";
import { prisma } from "../db.js";
import { toLiveTier } from "../judge/tiers.js";
import { isJudgeV3PolicyEnabled } from "../judge/v3/flags.js";
import { isShownHeld, toV3ItemRow } from "../judge/v3/item-wire.js";
import { interruptBudgetStatus } from "../judge/v3/push-budget-gate.js";
import { DEFAULT_TIME_ZONE } from "../time-zone.js";
import { getUserTimeZone } from "../user-timezone.js";
import type { DesktopApp } from "./alert-endpoints.js";
import { desktopReceiptDedupeKey } from "./channel-delivery-log.js";
import { DELIVERY_STATES, type DeliveryState, deliveryState } from "./delivery-lifecycle.js";
import { type GroupInput, needsLocalDay, notificationGroup } from "./notification-group.js";
import { REASON_ITEM_SELECT, type ReasonItemRow, reasonsForMail } from "./notification-reason.js";

export type NotificationCenterRow = NotificationRow;

const CENTER_ITEM_SELECT = {
  sourceId: true,
  snoozedUntil: true,
  ...REASON_ITEM_SELECT,
} as const;

type CenterItem = ReasonItemRow & { sourceId: string; snoozedUntil: Date | null };

interface CenterMail {
  id: string;
  subject: string;
  receivedAt: Date;
  needsReply: boolean;
  repliedAt: Date | null;
}

export interface EnrichOptions {
  /** The reader's language; called only when a row has a reason to render. */
  language: () => Promise<string>;
  now?: Date;
}

export async function enrichNotifications(
  userId: string,
  rows: readonly NotificationDTO[],
  opts: EnrichOptions,
): Promise<NotificationCenterRow[]> {
  const now = opts.now ?? new Date();
  const emailIds = [...new Set(rows.flatMap((r) => (r.sourceEmailId ? [r.sourceEmailId] : [])))];
  const { items, mails } = await loadMailContext(userId, emailIds);
  const reasons =
    items.size > 0
      ? await reasonsForMail(
          userId,
          [...mails.values()].map((m) => ({ id: m.id, subject: m.subject })),
          items,
          { language: await opts.language(), now, policyUser: isJudgeV3PolicyEnabled(userId) },
        )
      : new Map();

  const inputs = rows.map((row) => groupInput(row, items, mails));
  const timeZone = inputs.some(needsLocalDay) ? await getUserTimeZone(userId) : DEFAULT_TIME_ZONE;

  return rows.map((row, i) => {
    const emailId = row.sourceEmailId;
    const mail = emailId ? mails.get(emailId) : undefined;
    const item = emailId && mail ? items.get(emailId) : undefined;
    const group = notificationGroup(inputs[i] as GroupInput, { now, timeZone });
    if (!item) return { ...row, group };
    const reason = reasons.get(item.sourceId) ?? null;
    return {
      ...row,
      ...(item.tier ? { lane: toLiveTier(item.tier) } : {}),
      ...(reason ? { reason } : {}),
      held: isShownHeld(toV3ItemRow(item), now),
      group,
    };
  });
}

async function loadMailContext(
  userId: string,
  emailIds: readonly string[],
): Promise<{ items: Map<string, CenterItem>; mails: Map<string, CenterMail> }> {
  if (emailIds.length === 0) return { items: new Map(), mails: new Map() };
  const [itemRows, mailRows] = await Promise.all([
    prisma.attentionItem.findMany({
      where: { userId, source: "EMAIL", sourceId: { in: [...emailIds] } },
      select: CENTER_ITEM_SELECT,
    }),
    prisma.emailMessage.findMany({
      where: { userId, id: { in: [...emailIds] } },
      select: { id: true, subject: true, receivedAt: true, needsReply: true, repliedAt: true },
    }),
  ]);
  const mails = new Map(mailRows.map((m) => [m.id, m]));
  // An item counts only beside the user's own mail row.
  const items = new Map(
    itemRows.filter((i) => mails.has(i.sourceId)).map((i) => [i.sourceId, i as CenterItem]),
  );
  return { items, mails };
}

function groupInput(
  row: NotificationDTO,
  items: ReadonlyMap<string, CenterItem>,
  mails: ReadonlyMap<string, CenterMail>,
): GroupInput {
  const mail = row.sourceEmailId ? mails.get(row.sourceEmailId) : undefined;
  const item = mail ? items.get(mail.id) : undefined;
  return {
    isRead: row.isRead,
    type: row.type,
    createdAt: new Date(row.createdAt),
    pendingActionStatus: row.pendingActionStatus,
    item: item
      ? {
          tier: item.tier,
          status: item.status,
          v3Due: item.v3Due,
          snoozedUntil: item.snoozedUntil,
        }
      : null,
    email: mail
      ? { receivedAt: mail.receivedAt, needsReply: mail.needsReply, repliedAt: mail.repliedAt }
      : null,
  };
}

/**
 * The day's interrupt budget for the list response, only when it applies to
 * the user: policy v3 covers them and the limit is finite (JUDGE_V3_PUSH_BUDGET
 * "unlimited" or no policy → null, and the field is omitted).
 */
export async function notificationBudget(
  userId: string,
  now: Date = new Date(),
): Promise<NotificationBudget | null> {
  if (!isJudgeV3PolicyEnabled(userId)) return null;
  const { used, limit } = await interruptBudgetStatus(userId, now);
  return limit === null ? null : { used, limit };
}

// ── Delivery ────────────────────────────────────────────────────────────────

/** Rows written this long before the bell row still count (clock slack). */
const DELIVERY_SLACK_MS = 60_000;
/** Upper bound on rows read for one bell row (one per channel attempt). */
const MAX_DELIVERY_ROWS = 200;
const DESKTOP_APPS: readonly DesktopApp[] = ["mac", "windows"];
const SENT_RANK = DELIVERY_STATES.indexOf("sent");

/** Web push named by its push service's host (PushDeliveryLog.endpointHost). */
function webPushName(host: string | null): DeliveryChannelName {
  const h = (host ?? "").toLowerCase();
  if (h === "fcm.googleapis.com") return "chrome";
  if (h === "web.push.apple.com") return "safari";
  if (h.endsWith(".mozilla.com")) return "firefox";
  if (h.endsWith(".notify.windows.com")) return "edge";
  return "web";
}

function channelName(channel: string, endpointHost: string | null): DeliveryChannelName | null {
  switch (channel) {
    case "web":
      return webPushName(endpointHost);
    case "fcm":
      return "android";
    case "apns":
      return "ios";
    case "telegram":
      return "telegram";
    case "desktop_mac":
      return "mac";
    case "desktop_windows":
      return "windows";
    default:
      return null;
  }
}

export async function notificationDelivery(
  userId: string,
  notificationId: string,
): Promise<NotificationDelivery | null> {
  const bellRow = await prisma.notification.findFirst({
    where: { id: notificationId, userId, type: { not: HIDDEN_CLAIM_TYPE } },
    select: { id: true, sourceEmailId: true, createdAt: true },
  });
  if (!bellRow) return null;
  const item = bellRow.sourceEmailId
    ? await prisma.attentionItem.findFirst({
        where: { userId, source: "EMAIL", sourceId: bellRow.sourceEmailId },
        select: { id: true },
      })
    : null;
  const rows = await prisma.pushDeliveryLog.findMany({
    where: {
      userId,
      createdAt: { gte: new Date(bellRow.createdAt.getTime() - DELIVERY_SLACK_MS) },
      OR: [
        { bellNotificationId: bellRow.id },
        { notificationId: bellRow.id },
        ...(item
          ? [
              {
                dedupeKey: {
                  in: DESKTOP_APPS.map((app) =>
                    desktopReceiptDedupeKey(userId, app, "attention_item", item.id),
                  ),
                },
              },
            ]
          : []),
      ],
    },
    select: {
      channel: true,
      endpointHost: true,
      queuedAt: true,
      acceptedAt: true,
      receivedAt: true,
      clickedAt: true,
      actionedAt: true,
    },
    orderBy: { createdAt: "asc" },
    take: MAX_DELIVERY_ROWS,
  });
  return deliverySummary(rows);
}

type DeliveryRow = Parameters<typeof deliveryState>[0] & {
  channel: string;
  endpointHost: string | null;
};

/** Each channel name once, at its furthest stage; furthest first. Pure. */
export function deliverySummary(rows: readonly DeliveryRow[]): NotificationDelivery {
  const furthest = new Map<DeliveryChannelName, DeliveryState>();
  for (const row of rows) {
    const name = channelName(row.channel, row.endpointHost);
    const state = deliveryState(row);
    if (!name || DELIVERY_STATES.indexOf(state) < SENT_RANK) continue;
    const seen = furthest.get(name);
    if (!seen || DELIVERY_STATES.indexOf(state) > DELIVERY_STATES.indexOf(seen)) {
      furthest.set(name, state);
    }
  }
  const channels = [...furthest.entries()]
    .map(([name, state]) => ({ name, state: state as DeliveredState }))
    .sort((a, b) => DELIVERY_STATES.indexOf(b.state) - DELIVERY_STATES.indexOf(a.state));
  return { deliveredTo: channels.map((c) => c.name), channels };
}
