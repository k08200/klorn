/**
 * Push delivery observability.
 *
 * Web Push `sendNotification` success only means the browser vendor push
 * service accepted the payload. The service worker receipt is the stronger
 * dogfooding signal that the installed app actually received/clicked it.
 */

import { prisma } from "./db.js";

export type PushDeliveryStatus = "PENDING" | "ACCEPTED" | "FAILED" | "SKIPPED";
export type PushReceiptEvent = "received" | "clicked";

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
  recent: PushDeliveryLogDTO[];
}

export interface PushDeliveryLogDTO {
  id: string;
  category: string;
  title: string;
  status: string;
  skipReason: string | null;
  endpointHost: string | null;
  errorStatusCode: number | null;
  acceptedAt: string | null;
  receivedAt: string | null;
  clickedAt: string | null;
  createdAt: string;
}

type PushDeliveryLogRow = {
  id: string;
  category: string;
  title: string;
  status: string;
  skipReason: string | null;
  endpointHost: string | null;
  errorStatusCode: number | null;
  acceptedAt: Date | null;
  receivedAt: Date | null;
  clickedAt: Date | null;
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

export async function markPushAccepted(deliveryId: string, now = new Date()): Promise<void> {
  await prisma.pushDeliveryLog.update({
    where: { id: deliveryId },
    data: { status: "ACCEPTED", acceptedAt: now },
  });
}

export async function markPushFailed(
  deliveryId: string,
  error: { statusCode?: number; body?: string },
): Promise<void> {
  await prisma.pushDeliveryLog.update({
    where: { id: deliveryId },
    data: {
      status: "FAILED",
      errorStatusCode: error.statusCode ?? null,
      errorBody: error.body ? error.body.slice(0, 1000) : null,
    },
  });
}

export async function recordPushReceipt(
  deliveryId: string,
  event: PushReceiptEvent,
  now = new Date(),
): Promise<boolean> {
  if (event === "clicked") {
    const [received, clicked] = await Promise.all([
      prisma.pushDeliveryLog.updateMany({
        where: { id: deliveryId, receivedAt: null },
        data: { receivedAt: now },
      }),
      prisma.pushDeliveryLog.updateMany({
        where: { id: deliveryId },
        data: { clickedAt: now },
      }),
    ]);
    return received.count + clicked.count > 0;
  }

  const result = await prisma.pushDeliveryLog.updateMany({
    where: { id: deliveryId },
    data: { receivedAt: now },
  });
  return result.count > 0;
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

  const accepted = rows.filter((row) => row.status === "ACCEPTED").length;
  const failed = rows.filter((row) => row.status === "FAILED").length;
  const skipped = rows.filter((row) => row.status === "SKIPPED").length;
  const received = rows.filter((row) => row.receivedAt).length;
  const clicked = rows.filter((row) => row.clickedAt).length;

  return {
    since: since.toISOString(),
    total: rows.length,
    accepted,
    failed,
    skipped,
    received,
    clicked,
    receiptRate: accepted > 0 ? roundRate(received / accepted) : null,
    clickRate: accepted > 0 ? roundRate(clicked / accepted) : null,
    recent: rows.slice(0, limit).map(toDTO),
  };
}

function toDTO(row: PushDeliveryLogRow): PushDeliveryLogDTO {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    status: row.status,
    skipReason: row.skipReason,
    endpointHost: row.endpointHost,
    errorStatusCode: row.errorStatusCode,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    receivedAt: row.receivedAt?.toISOString() ?? null,
    clickedAt: row.clickedAt?.toISOString() ?? null,
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
