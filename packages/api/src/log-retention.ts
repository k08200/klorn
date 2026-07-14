/**
 * Operational-log retention sweep.
 *
 * Six append-only log tables grow without bound (the decision/feedback
 * ledgers — DecisionLabel, FeedbackEvent — are deliberately NOT here: they
 * feed calibration and learned rules and must be kept). Today a DELETE is one
 * cheap statement; at hundreds of millions of rows the same cleanup becomes a
 * partitioning project, so the sweep ships now and runs from day one.
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

export interface LogRetentionPolicy {
  name: string;
  column: string;
  days: number;
  deleteOlderThan: (cutoff: Date) => Promise<{ count: number }>;
}

export const LOG_RETENTION_POLICIES: LogRetentionPolicy[] = [
  {
    // Agent action trail — debugging/UX surface, not a learning input.
    name: "agentLog",
    column: "createdAt",
    days: 90,
    deleteOlderThan: (cutoff) =>
      prisma.agentLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  },
  {
    // SHADOW/SUGGEST/AUTO processing trail; soft-references emails by design.
    name: "emailProcessingLog",
    column: "processedAt",
    days: 90,
    deleteOlderThan: (cutoff) =>
      prisma.emailProcessingLog.deleteMany({ where: { processedAt: { lt: cutoff } } }),
  },
  {
    // Per-attempt push delivery receipts; stats windows are days, not months.
    name: "pushDeliveryLog",
    column: "createdAt",
    days: 90,
    deleteOlderThan: (cutoff) =>
      prisma.pushDeliveryLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  },
  {
    // Rate-limit window rows — the caps look back 60 minutes at most; the
    // schema comment already anticipates pruning.
    name: "pushRingEvent",
    column: "createdAt",
    days: 30,
    deleteOlderThan: (cutoff) =>
      prisma.pushRingEvent.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  },
  {
    // Webhook idempotency ledger — Stripe retries at most 72h; 90 days keeps
    // a generous dedup window while the table stays bounded.
    name: "webhookEvent",
    column: "processedAt",
    days: 90,
    deleteOlderThan: (cutoff) =>
      prisma.webhookEvent.deleteMany({ where: { processedAt: { lt: cutoff } } }),
  },
  {
    // Ground-truth token accounting; kept longer for cost-drift analysis.
    name: "llmUsageLog",
    column: "createdAt",
    days: 180,
    deleteOlderThan: (cutoff) =>
      prisma.llmUsageLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  },
];

export function isLogRetentionEnabled(): boolean {
  return process.env.LOG_RETENTION_ENABLED === "true" || process.env.LOG_RETENTION_ENABLED === "1";
}

export function retentionCutoff(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * Delete rows past each table's window. Per-table isolation: one failing
 * DELETE (lock timeout, transient outage) must not starve the other tables,
 * so failures are captured and reported as -1 instead of thrown.
 */
export async function runLogRetentionSweep(
  now: Date = new Date(),
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const policy of LOG_RETENTION_POLICIES) {
    try {
      const { count } = await policy.deleteOlderThan(retentionCutoff(policy.days, now));
      result[policy.name] = count;
      if (count > 0) {
        console.log(`[RETENTION] ${policy.name}: deleted ${count} rows older than ${policy.days}d`);
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
