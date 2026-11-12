/**
 * Delivery rows (PushDeliveryLog) for channels other than web push, and the
 * owner-scoped status read. Web push keeps its own writer (push-delivery.ts),
 * which creates the row before the send so the service worker can carry its id.
 *
 *   - FCM / APNs / Telegram: one row per channel attempt of a notification,
 *     written once the attempt settled. These channels report no device
 *     receipt, so the furthest stage they reach is "sent".
 *   - Desktop apps: the app reports shown / clicked / actioned for a banner
 *     (routes/desktop-receipts.ts). The row is created by the first report, at
 *     most once per (app, subject) via its dedupe key, and each stage is
 *     stamped by its first observation only.
 *
 * Writers here never throw into a notification path: a log failure is logged
 * and swallowed by recordChannelSend, whose callers are best-effort channels.
 */

import { prisma } from "../db.js";
import type { DesktopApp } from "./alert-endpoints.js";
import {
  type DeliveryChannel,
  type DeliveryState,
  deliveryState,
  desktopChannel,
  REPORTED_STATUS,
  type ReceiptAction,
} from "./delivery-lifecycle.js";

export type ChannelSendOutcome = { status: "sent" } | { status: "failed"; reason: string };

export interface ChannelSendInput {
  userId: string;
  channel: Extract<DeliveryChannel, "fcm" | "apns" | "telegram">;
  notificationId?: string | null;
  category: string;
  title: string;
  outcome: ChannelSendOutcome;
  /** When the attempt was handed to the provider. */
  queuedAt: Date;
  now?: Date;
}

/** Record one settled FCM / APNs / Telegram attempt. Returns the row id, or
 *  null when the write failed (logged, never thrown). */
export async function recordChannelSend(input: ChannelSendInput): Promise<string | null> {
  const now = input.now ?? new Date();
  const sent = input.outcome.status === "sent";
  try {
    const row = await prisma.pushDeliveryLog.create({
      data: {
        userId: input.userId,
        channel: input.channel,
        notificationId: input.notificationId ?? null,
        category: input.category,
        title: input.title,
        status: sent ? "ACCEPTED" : "FAILED",
        skipReason: input.outcome.status === "failed" ? input.outcome.reason : null,
        queuedAt: input.queuedAt,
        acceptedAt: sent ? now : null,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    console.warn(`[PUSH] Could not record ${input.channel} delivery for ${input.userId}:`, err);
    return null;
  }
}

/** The shape sendDevicePush / sendApnsPush resolve with. */
export interface NativeSendSummary {
  status: "sent" | "skipped";
  reason?: string;
  tokens: number;
  accepted: number;
  failed: number;
}

/** Skips that mean "this channel had nothing to attempt" — not recorded, or
 *  every push of every user without a phone would write two empty rows. */
const NOT_ATTEMPTED = new Set([
  "no_device_tokens",
  "missing_firebase_credentials",
  "missing_apns_credentials",
]);

/** What an FCM / APNs summary records: sent, failed, or nothing at all. */
export function nativeSendOutcome(
  summary: NativeSendSummary | undefined | null,
): ChannelSendOutcome | null {
  if (!summary) return null;
  if (summary.status === "sent") {
    return summary.accepted > 0
      ? { status: "sent" }
      : { status: "failed", reason: "all_tokens_failed" };
  }
  const reason = summary.reason ?? "unknown";
  return NOT_ATTEMPTED.has(reason) ? null : { status: "failed", reason };
}

export const DESKTOP_RECEIPT_EVENTS = ["shown", "clicked", "actioned"] as const;
export type DesktopReceiptEvent = (typeof DESKTOP_RECEIPT_EVENTS)[number];

/** What a desktop banner was about — the id the app keyed the banner on. */
export const DESKTOP_RECEIPT_KINDS = ["notification", "attention_item", "calendar_event"] as const;
export type DesktopReceiptKind = (typeof DESKTOP_RECEIPT_KINDS)[number];

export interface DesktopReceiptInput {
  userId: string;
  app: DesktopApp;
  event: DesktopReceiptEvent;
  kind: DesktopReceiptKind;
  id: string;
  action?: ReceiptAction;
  now?: Date;
}

async function ownsSubject(userId: string, kind: DesktopReceiptKind, id: string) {
  const query = { where: { id, userId }, select: { id: true } } as const;
  if (kind === "notification") return prisma.notification.findFirst(query);
  if (kind === "attention_item") return prisma.attentionItem.findFirst(query);
  return prisma.calendarEvent.findFirst(query);
}

/**
 * Record a desktop app's report about one of its banners. "not_found" when the
 * subject is not the caller's own (or does not exist) — indistinguishable on
 * purpose. Idempotent: a repeated report changes nothing.
 */
export async function recordDesktopReceipt(
  input: DesktopReceiptInput,
): Promise<"recorded" | "not_found"> {
  const { userId, app, event, kind, id } = input;
  if (!(await ownsSubject(userId, kind, id))) return "not_found";
  const now = input.now ?? new Date();
  const dedupeKey = `desktop:${app}:${kind}:${id}`;
  await prisma.pushDeliveryLog.createMany({
    data: [
      {
        userId,
        channel: desktopChannel(app),
        dedupeKey,
        // Only a bell row id links the row to the bell (and to the per-
        // notification view across channels); other subjects stay in the key.
        notificationId: kind === "notification" ? id : null,
        category: "desktop_banner",
        title: "",
        status: REPORTED_STATUS,
      },
    ],
    skipDuplicates: true,
  });
  const where = { dedupeKey, userId };
  await prisma.pushDeliveryLog.updateMany({
    where: { ...where, receivedAt: null },
    data: { receivedAt: now },
  });
  if (event === "shown") return "recorded";
  await prisma.pushDeliveryLog.updateMany({
    where: { ...where, clickedAt: null },
    data: { clickedAt: now },
  });
  if (event === "actioned" && input.action) {
    await prisma.pushDeliveryLog.updateMany({
      where: { ...where, actionedAt: null },
      data: { actionedAt: now, action: input.action },
    });
  }
  return "recorded";
}

export interface DeliveryStatusDTO {
  id: string;
  channel: string;
  status: string;
  state: DeliveryState;
  createdAt: string;
  queuedAt: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  openedAt: string | null;
  actionedAt: string | null;
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

/** One of the caller's own delivery rows, as its lifecycle; null otherwise. */
export async function getDeliveryStatus(
  userId: string,
  deliveryId: string,
): Promise<DeliveryStatusDTO | null> {
  const row = await prisma.pushDeliveryLog.findFirst({
    where: { id: deliveryId, userId },
    select: {
      id: true,
      channel: true,
      status: true,
      createdAt: true,
      queuedAt: true,
      acceptedAt: true,
      receivedAt: true,
      clickedAt: true,
      actionedAt: true,
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    channel: row.channel,
    status: row.status,
    state: deliveryState(row),
    createdAt: row.createdAt.toISOString(),
    queuedAt: iso(row.queuedAt),
    sentAt: iso(row.acceptedAt),
    receivedAt: iso(row.receivedAt),
    openedAt: iso(row.clickedAt),
    actionedAt: iso(row.actionedAt),
  };
}
