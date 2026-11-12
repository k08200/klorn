/**
 * Push delivery observability.
 *
 * Web Push `sendNotification` success only means the browser vendor push
 * service accepted the payload. The service worker receipt is the stronger
 * dogfooding signal that the installed app actually received/clicked it.
 */

import { prisma } from "../db.js";
import {
  DELIVERY_CHANNELS,
  type DeliveryChannel,
  type DeliveryState,
  deliveryState,
  type ReceiptAction,
} from "./delivery-lifecycle.js";
import { clearZombieFlag } from "./push-zombie.js";

export type PushDeliveryStatus = "PENDING" | "ACCEPTED" | "FAILED" | "SKIPPED";
export type PushReceiptEvent = "received" | "clicked" | "actioned";

export interface PushDeliveryAttemptInput {
  userId: string;
  subscriptionId?: string | null;
  endpoint?: string | null;
  notificationId?: string | null;
  category: string;
  title: string;
}

export interface PushDeliverySkipInput {
  userId: string;
  category: string;
  title: string;
  skipReason: string;
}

/** Every channel's rows by lifecycle stage reached (a row counts toward each
 *  stage it reached), plus the failed / skipped outcomes. */
export interface ChannelStageCounts {
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  deviceReceived: number;
  opened: number;
  actioned: number;
}

/**
 * The top-level counts and rates are web push only, as they always were
 * (receiptRate is a service-worker rate); `channels` breaks every channel out.
 */
export interface PushDeliveryStats {
  since: string;
  total: number;
  accepted: number;
  failed: number;
  skipped: number;
  received: number;
  clicked: number;
  receiptRate: number | null;
  clickRate: number | null;
  channels: Partial<Record<DeliveryChannel, ChannelStageCounts>>;
  recent: PushDeliveryLogDTO[];
}

export interface PushDeliveryLogDTO {
  id: string;
  channel: string;
  state: DeliveryState;
  category: string;
  title: string;
  status: string;
  skipReason: string | null;
  endpointHost: string | null;
  errorStatusCode: number | null;
  queuedAt: string | null;
  acceptedAt: string | null;
  receivedAt: string | null;
  clickedAt: string | null;
  actionedAt: string | null;
  action: string | null;
  createdAt: string;
}

type PushDeliveryLogRow = {
  id: string;
  channel?: string | null;
  category: string;
  title: string;
  status: string;
  skipReason: string | null;
  endpointHost: string | null;
  errorStatusCode: number | null;
  queuedAt?: Date | null;
  acceptedAt: Date | null;
  receivedAt: Date | null;
  clickedAt: Date | null;
  actionedAt?: Date | null;
  action?: string | null;
  createdAt: Date;
};

const DEFAULT_LOOKBACK_HOURS = 24;
const MAX_LOOKBACK_HOURS = 24 * 14;
const DEFAULT_RECENT_LIMIT = 20;
const MAX_RECENT_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Retention: delete PushDeliveryLog rows older than `olderThanDays`.
 *
 * The table only ever shrank on account deletion, so at fleet scale it grows
 * unbounded. This is an ops/cron job (scripts/prune-push-logs.ts) — it is NOT
 * wired into the automation scheduler.
 *
 * Prisma's deleteMany has no LIMIT, so a single unbounded delete would lock a
 * huge row set. Instead we page ids via findMany(take: batchSize) and delete
 * them by id-set until a page comes back empty. Returns the total deleted and
 * logs the count only (no PII).
 */
export async function pruneOldPushDeliveryLogs(
  olderThanDays = 90,
  batchSize = 5000,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * DAY_MS);
  let deleted = 0;
  for (;;) {
    const rows = await prisma.pushDeliveryLog.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: batchSize,
    });
    if (rows.length === 0) break;
    const ids = rows.map((row) => row.id);
    const result = await prisma.pushDeliveryLog.deleteMany({ where: { id: { in: ids } } });
    deleted += result.count;
  }
  console.log(`[push-delivery] pruned ${deleted} log(s) older than ${olderThanDays}d`);
  return deleted;
}

export async function createPushDeliveryAttempt(input: PushDeliveryAttemptInput): Promise<string> {
  const row = await prisma.pushDeliveryLog.create({
    data: {
      userId: input.userId,
      subscriptionId: input.subscriptionId ?? null,
      notificationId: input.notificationId ?? null,
      endpointHost: endpointHost(input.endpoint),
      category: input.category,
      title: input.title,
      status: "PENDING",
    },
    select: { id: true },
  });
  return row.id;
}

export async function createSkippedPushDelivery(input: PushDeliverySkipInput): Promise<void> {
  await prisma.pushDeliveryLog.create({
    data: {
      userId: input.userId,
      category: input.category,
      title: input.title,
      status: "SKIPPED",
      skipReason: input.skipReason,
    },
  });
}

/**
 * The push service accepted the send (stage "sent"). `queuedAt` is when the
 * first attempt was handed to it, written in the same update so a push costs
 * no extra write.
 */
export async function markPushAccepted(
  deliveryId: string,
  now = new Date(),
  queuedAt?: Date,
): Promise<void> {
  await prisma.pushDeliveryLog.update({
    where: { id: deliveryId },
    data: { status: "ACCEPTED", acceptedAt: now, ...(queuedAt ? { queuedAt } : {}) },
  });
}

export async function markPushFailed(
  deliveryId: string,
  error: { statusCode?: number; body?: string },
  queuedAt?: Date,
): Promise<void> {
  await prisma.pushDeliveryLog.update({
    where: { id: deliveryId },
    data: {
      status: "FAILED",
      errorStatusCode: error.statusCode ?? null,
      errorBody: error.body ? error.body.slice(0, 1000) : null,
      ...(queuedAt ? { queuedAt } : {}),
    },
  });
}

/**
 * A service worker receipt for one web push row. Each stage is stamped by its
 * first observation only, so a retried or duplicated receipt changes nothing.
 * A click (or an action button) also stamps device_received when that receipt
 * never arrived: a notification that was clicked was on the device. Returns
 * false for an unknown id — or a row of another channel: the deliveryId
 * capability only ever travels inside a web push payload.
 */
export async function recordPushReceipt(
  deliveryId: string,
  event: PushReceiptEvent,
  now = new Date(),
  action?: ReceiptAction,
): Promise<boolean> {
  const row = await prisma.pushDeliveryLog.findFirst({
    where: { id: deliveryId, channel: "web" },
    select: { subscriptionId: true },
  });
  if (!row) return false;

  await prisma.pushDeliveryLog.updateMany({
    where: { id: deliveryId, receivedAt: null },
    data: { receivedAt: now },
  });
  if (event !== "received") {
    await prisma.pushDeliveryLog.updateMany({
      where: { id: deliveryId, clickedAt: null },
      data: { clickedAt: now },
    });
  }
  if (event === "actioned" && action) {
    await prisma.pushDeliveryLog.updateMany({
      where: { id: deliveryId, actionedAt: null },
      data: { actionedAt: now, action },
    });
  }
  if (row.subscriptionId) {
    await clearZombieFlag(row.subscriptionId).catch((err) => {
      console.warn(`[PUSH] Could not clear needs-resubscribe on ${row.subscriptionId}:`, err);
    });
  }
  return true;
}

export async function getPushDeliveryStats(
  userId: string,
  opts: { hours?: number; limit?: number; now?: number } = {},
): Promise<PushDeliveryStats> {
  const hours = normalizeHours(opts.hours);
  const limit = normalizeLimit(opts.limit);
  const since = new Date((opts.now ?? Date.now()) - hours * 60 * 60 * 1000);
  const rows = (await prisma.pushDeliveryLog.findMany({
    where: { userId, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: Math.max(limit, 500),
  })) as PushDeliveryLogRow[];

  const web = rows.filter((row) => channelOf(row) === "web");
  const accepted = web.filter((row) => row.status === "ACCEPTED").length;
  const failed = web.filter((row) => row.status === "FAILED").length;
  const skipped = web.filter((row) => row.status === "SKIPPED").length;
  const received = web.filter((row) => row.receivedAt).length;
  const clicked = web.filter((row) => row.clickedAt).length;

  return {
    since: since.toISOString(),
    total: web.length,
    accepted,
    failed,
    skipped,
    received,
    clicked,
    receiptRate: accepted > 0 ? roundRate(received / accepted) : null,
    clickRate: accepted > 0 ? roundRate(clicked / accepted) : null,
    channels: countByChannel(rows),
    recent: rows.slice(0, limit).map(toDTO),
  };
}

function channelOf(row: PushDeliveryLogRow): string {
  return row.channel ?? "web";
}

function countByChannel(
  rows: PushDeliveryLogRow[],
): Partial<Record<DeliveryChannel, ChannelStageCounts>> {
  const out: Partial<Record<DeliveryChannel, ChannelStageCounts>> = {};
  for (const channel of DELIVERY_CHANNELS) {
    const mine = rows.filter((row) => channelOf(row) === channel);
    if (mine.length === 0) continue;
    out[channel] = {
      total: mine.length,
      sent: mine.filter((row) => row.acceptedAt).length,
      failed: mine.filter((row) => row.status === "FAILED").length,
      skipped: mine.filter((row) => row.status === "SKIPPED").length,
      deviceReceived: mine.filter((row) => row.receivedAt).length,
      opened: mine.filter((row) => row.clickedAt).length,
      actioned: mine.filter((row) => row.actionedAt).length,
    };
  }
  return out;
}

function toDTO(row: PushDeliveryLogRow): PushDeliveryLogDTO {
  return {
    id: row.id,
    channel: channelOf(row),
    state: deliveryState({
      queuedAt: row.queuedAt ?? null,
      acceptedAt: row.acceptedAt,
      receivedAt: row.receivedAt,
      clickedAt: row.clickedAt,
      actionedAt: row.actionedAt ?? null,
    }),
    category: row.category,
    title: row.title,
    status: row.status,
    skipReason: row.skipReason,
    endpointHost: row.endpointHost,
    errorStatusCode: row.errorStatusCode,
    queuedAt: row.queuedAt?.toISOString() ?? null,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    receivedAt: row.receivedAt?.toISOString() ?? null,
    clickedAt: row.clickedAt?.toISOString() ?? null,
    actionedAt: row.actionedAt?.toISOString() ?? null,
    action: row.action ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function endpointHost(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).hostname;
  } catch {
    return null;
  }
}

function normalizeHours(hours: number | undefined): number {
  if (!Number.isFinite(hours) || !hours || hours < 1) return DEFAULT_LOOKBACK_HOURS;
  return Math.min(Math.floor(hours), MAX_LOOKBACK_HOURS);
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit || limit < 1) return DEFAULT_RECENT_LIMIT;
  return Math.min(Math.floor(limit), MAX_RECENT_LIMIT);
}

function roundRate(rate: number): number {
  return Math.round(rate * 1000) / 1000;
}
