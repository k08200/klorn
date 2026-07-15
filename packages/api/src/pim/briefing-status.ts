/**
 * Today's briefing status.
 *
 * Combines the generated briefing note, its notification, push delivery
 * receipts, and the user's briefing automation config into one small object
 * for the Command Center.
 */

import { prisma } from "../db.js";
import { localDayUtcRange, normalizeTimeZone } from "../time-zone.js";

export type BriefingPushState =
  | "received"
  | "accepted"
  | "failed"
  | "skipped"
  | "pending"
  | "not_sent"
  | "no_subscription";

export interface BriefingStatus {
  date: string;
  generated: boolean;
  note: {
    id: string;
    content: string;
    preview: string;
    createdAt: string;
  } | null;
  notification: {
    id: string;
    title: string;
    message: string;
    createdAt: string;
  } | null;
  push: {
    state: BriefingPushState;
    reason: string | null;
    deliveryId: string | null;
    acceptedAt: string | null;
    receivedAt: string | null;
    clickedAt: string | null;
  };
  automation: {
    configured: boolean;
    enabled: boolean;
    briefingTime: string | null;
    timezone: string;
    reason: "no_config" | "disabled" | null;
  };
}

type NoteRow = { id: string; content: string; createdAt: Date };
type NotificationRow = { id: string; title: string; message: string; createdAt: Date };
type PushLogRow = {
  id: string;
  status: string;
  skipReason: string | null;
  acceptedAt: Date | null;
  receivedAt: Date | null;
  clickedAt: Date | null;
  errorStatusCode: number | null;
  createdAt: Date;
};
type AutomationConfigRow = {
  dailyBriefing: boolean;
  briefingTime: string;
  timezone?: string | null;
};

export async function getBriefingStatus(
  userId: string,
  opts: { now?: Date } = {},
): Promise<BriefingStatus> {
  const now = opts.now ?? new Date();
  const config = (await prisma.automationConfig.findUnique({
    where: { userId },
    select: { dailyBriefing: true, briefingTime: true, timezone: true },
  })) as AutomationConfigRow | null;
  const timeZone = normalizeTimeZone(config?.timezone);
  const today = localDayUtcRange(now, timeZone);

  const [note, notification, pushSubscriptions] = await Promise.all([
    prisma.note.findFirst({
      where: {
        userId,
        title: { startsWith: "Daily Briefing" },
        createdAt: { gte: today.gte, lt: today.lt },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, content: true, createdAt: true },
    }) as Promise<NoteRow | null>,
    prisma.notification.findFirst({
      where: {
        userId,
        type: "briefing",
        createdAt: { gte: today.gte, lt: today.lt },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, message: true, createdAt: true },
    }) as Promise<NotificationRow | null>,
    prisma.pushSubscription.count({ where: { userId } }),
  ]);

  const pushLog = await findBriefingPushLog(userId, today.gte, today.lt, notification?.id);

  return {
    date: today.dateKey,
    generated: note !== null,
    note: note
      ? {
          id: note.id,
          content: note.content,
          preview: previewBriefing(note.content),
          createdAt: note.createdAt.toISOString(),
        }
      : null,
    notification: notification
      ? {
          id: notification.id,
          title: notification.title,
          message: notification.message,
          createdAt: notification.createdAt.toISOString(),
        }
      : null,
    push: pushStatus(pushLog, pushSubscriptions),
    automation: {
      configured: config !== null,
      enabled: config?.dailyBriefing ?? false,
      briefingTime: config?.briefingTime ?? null,
      timezone: timeZone,
      reason: config ? (config.dailyBriefing ? null : "disabled") : "no_config",
    },
  };
}

async function findBriefingPushLog(
  userId: string,
  todayStart: Date,
  tomorrowStart: Date,
  notificationId: string | undefined,
): Promise<PushLogRow | null> {
  const where = {
    userId,
    category: "daily_briefing",
    createdAt: { gte: todayStart, lt: tomorrowStart },
  };
  const logs = (await prisma.pushDeliveryLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      status: true,
      skipReason: true,
      acceptedAt: true,
      receivedAt: true,
      clickedAt: true,
      errorStatusCode: true,
      createdAt: true,
      notificationId: true,
    },
  })) as Array<PushLogRow & { notificationId: string | null }>;

  if (notificationId) {
    const exact = logs.find((log) => log.notificationId === notificationId);
    if (exact) return exact;
  }
  return logs[0] ?? null;
}

function pushStatus(log: PushLogRow | null, subscriptionCount: number): BriefingStatus["push"] {
  if (!log) {
    return {
      state: subscriptionCount > 0 ? "not_sent" : "no_subscription",
      reason: subscriptionCount > 0 ? null : "no_subscriptions",
      deliveryId: null,
      acceptedAt: null,
      receivedAt: null,
      clickedAt: null,
    };
  }
  return {
    state: stateFor(log),
    reason: reasonFor(log),
    deliveryId: log.id,
    acceptedAt: log.acceptedAt?.toISOString() ?? null,
    receivedAt: log.receivedAt?.toISOString() ?? null,
    clickedAt: log.clickedAt?.toISOString() ?? null,
  };
}

function stateFor(log: PushLogRow): BriefingPushState {
  if (log.receivedAt) return "received";
  if (log.status === "ACCEPTED") return "accepted";
  if (log.status === "FAILED") return "failed";
  if (log.status === "SKIPPED")
    return log.skipReason === "no_subscriptions" ? "no_subscription" : "skipped";
  return "pending";
}

function reasonFor(log: PushLogRow): string | null {
  if (log.skipReason) return log.skipReason;
  if (log.status === "FAILED" && log.errorStatusCode) return `status_${log.errorStatusCode}`;
  return null;
}

function previewBriefing(content: string): string {
  const line =
    content
      .split(/\r?\n/)
      .map((part) => stripMarkdown(part).trim())
      .find((part) => part.length > 0) ?? "";
  return line.slice(0, 180);
}

function stripMarkdown(value: string): string {
  return value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/^\s*\d+\.\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/`/g, "")
    .trim();
}
