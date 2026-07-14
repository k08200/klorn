/**
 * Operational-log retention sweep.
 *
 * Six append-only log tables grow without bound (the decision/feedback
 * ledgers — DecisionLabel, FeedbackEvent — are deliberately NOT here: they
 * feed calibration and learned rules and must be kept). Today a DELETE is one
 * cheap statement; at hundreds of millions of rows the same cleanup becomes a
 * partitioning project, so the sweep ships now and runs from day one.
 *
 * Deletes are id-paged in bounded batches (mirroring pruneOldPushDeliveryLogs
 * in push-delivery.ts): a single unbounded `deleteMany` would take one huge
 * lock, and the first sweep after enabling the flag on a long-accumulated
 * table is exactly the worst case to run on the live dyno. Each table's
 * timestamp column is indexed (migration 20260714120000) so the batch lookup
 * is an index range scan, not a seq scan.
 *
 * OFF by default per the flag doctrine — set LOG_RETENTION_ENABLED=true to
 * turn it on. When off, the scheduler reports itself disabled-by-design to
 * the heartbeat registry instead of going missing.
 */

import { prisma } from "./db.js";
import {
  markSchedulerDisabled,
  recordSchedulerTick,
  registerScheduler,
} from "./scheduler-heartbeat.js";
import { captureError } from "./sentry.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FIRST_SWEEP_DELAY_MS = 5 * 60 * 1000; // let the server warm up first
const DELETE_BATCH_SIZE = 5000;

export interface LogRetentionPolicy {
  name: string;
  column: string;
  days: number;
  findExpiredIds: (cutoff: Date, take: number) => Promise<string[]>;
  deleteByIds: (ids: string[]) => Promise<{ count: number }>;
}

export const LOG_RETENTION_POLICIES: LogRetentionPolicy[] = [
  {
    // Agent action trail — debugging/UX surface, not a learning input.
    name: "agentLog",
    column: "createdAt",
    days: 90,
    findExpiredIds: (cutoff, take) =>
      prisma.agentLog
        .findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true }, take })
        .then((rows) => rows.map((r) => r.id)),
    deleteByIds: (ids) => prisma.agentLog.deleteMany({ where: { id: { in: ids } } }),
  },
  {
    // SHADOW/SUGGEST/AUTO processing trail; soft-references emails by design.
    name: "emailProcessingLog",
    column: "processedAt",
    days: 90,
    findExpiredIds: (cutoff, take) =>
      prisma.emailProcessingLog
        .findMany({ where: { processedAt: { lt: cutoff } }, select: { id: true }, take })
        .then((rows) => rows.map((r) => r.id)),
    deleteByIds: (ids) => prisma.emailProcessingLog.deleteMany({ where: { id: { in: ids } } }),
  },
  {
    // Per-attempt push delivery receipts; stats windows are days, not months.
    name: "pushDeliveryLog",
    column: "createdAt",
    days: 90,
    findExpiredIds: (cutoff, take) =>
      prisma.pushDeliveryLog
        .findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true }, take })
        .then((rows) => rows.map((r) => r.id)),
    deleteByIds: (ids) => prisma.pushDeliveryLog.deleteMany({ where: { id: { in: ids } } }),
  },
  {
    // Rate-limit window rows — push-rate-limit.ts already prunes these per-user
    // on each attempt; this is the fleet-wide backstop for inactive users.
    name: "pushRingEvent",
    column: "createdAt",
    days: 30,
    findExpiredIds: (cutoff, take) =>
      prisma.pushRingEvent
        .findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true }, take })
        .then((rows) => rows.map((r) => r.id)),
    deleteByIds: (ids) => prisma.pushRingEvent.deleteMany({ where: { id: { in: ids } } }),
  },
  {
    // Webhook idempotency ledger — Stripe retries at most 72h; 90 days keeps
    // a generous dedup window while the table stays bounded.
    name: "webhookEvent",
    column: "processedAt",
    days: 90,
    findExpiredIds: (cutoff, take) =>
      prisma.webhookEvent
        .findMany({ where: { processedAt: { lt: cutoff } }, select: { id: true }, take })
        .then((rows) => rows.map((r) => r.id)),
    deleteByIds: (ids) => prisma.webhookEvent.deleteMany({ where: { id: { in: ids } } }),
  },
  {
    // Ground-truth token accounting; kept longer for cost-drift analysis.
    name: "llmUsageLog",
    column: "createdAt",
    days: 180,
    findExpiredIds: (cutoff, take) =>
      prisma.llmUsageLog
        .findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true }, take })
        .then((rows) => rows.map((r) => r.id)),
    deleteByIds: (ids) => prisma.llmUsageLog.deleteMany({ where: { id: { in: ids } } }),
  },
];

export function isLogRetentionEnabled(): boolean {
  return process.env.LOG_RETENTION_ENABLED === "true" || process.env.LOG_RETENTION_ENABLED === "1";
}

export function retentionCutoff(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * Delete one table's expired rows in bounded id-paged batches. Returns the
 * total deleted. The find/delete pair loops until a page comes back empty,
 * so no single statement locks more than `batchSize` rows.
 */
async function sweepTable(
  policy: LogRetentionPolicy,
  now: Date,
  batchSize: number,
): Promise<number> {
  const cutoff = retentionCutoff(policy.days, now);
  let deleted = 0;
  for (;;) {
    const ids = await policy.findExpiredIds(cutoff, batchSize);
    if (ids.length === 0) break;
    const { count } = await policy.deleteByIds(ids);
    deleted += count;
    // A page smaller than the batch means we've reached the tail — stop before
    // an extra empty round-trip.
    if (ids.length < batchSize) break;
  }
  return deleted;
}

/**
 * Sweep every table past its window. Per-table isolation: one failing table
 * (lock timeout, transient outage) must not starve the others, so failures
 * are captured and reported as -1 instead of thrown.
 */
export async function runLogRetentionSweep(
  now: Date = new Date(),
  batchSize: number = DELETE_BATCH_SIZE,
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const policy of LOG_RETENTION_POLICIES) {
    try {
      const deleted = await sweepTable(policy, now, batchSize);
      result[policy.name] = deleted;
      if (deleted > 0) {
        console.log(
          `[RETENTION] ${policy.name}: deleted ${deleted} rows older than ${policy.days}d`,
        );
      }
    } catch (err) {
      result[policy.name] = -1;
      console.error(`[RETENTION] sweep failed for ${policy.name}:`, err);
      captureError(err, { tags: { scope: "log-retention" }, extra: { table: policy.name } });
    }
  }
  return result;
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let firstRunTimer: ReturnType<typeof setTimeout> | null = null;

export function startLogRetentionScheduler(): void {
  if (intervalId || firstRunTimer) return;

  if (!isLogRetentionEnabled()) {
    console.log("[RETENTION] Log retention disabled (set LOG_RETENTION_ENABLED=true to enable)");
    markSchedulerDisabled("log-retention");
    return;
  }

  console.log("[RETENTION] Log retention sweep started (every 6h)");
  registerScheduler("log-retention", SWEEP_INTERVAL_MS);

  firstRunTimer = setTimeout(() => {
    firstRunTimer = null;
    recordSchedulerTick("log-retention");
    runLogRetentionSweep().catch((err) =>
      captureError(err, { tags: { scope: "log-retention.first-sweep" } }),
    );
    intervalId = setInterval(() => {
      recordSchedulerTick("log-retention");
      runLogRetentionSweep().catch((err) =>
        captureError(err, { tags: { scope: "log-retention.sweep" } }),
      );
    }, SWEEP_INTERVAL_MS);
  }, FIRST_SWEEP_DELAY_MS);
  firstRunTimer.unref?.();
}

export function stopLogRetentionScheduler(): void {
  if (firstRunTimer) {
    clearTimeout(firstRunTimer);
    firstRunTimer = null;
  }
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[RETENTION] Log retention sweep stopped");
  }
}
