/**
 * Organization audit log retention (Klorn Teams launch feature 7; window and
 * reasoning in docs/design/team-mode-v3.md "Audit log retention").
 *
 * OrgAuditEvent rows (admin actions, cross-member free/busy reads) are kept
 * for ORG_AUDIT_RETENTION_DAYS and then deleted: once a day, by whichever
 * instance holds the "org-audit-retention" scheduler lease, in id-paged
 * batches so no statement locks more than a batch, and at most
 * MAX_BATCHES_PER_RUN batches a run so a first sweep over a long backlog
 * never holds the lease for long (the rest goes the next day, and the backlog
 * is reported).
 *
 * Not behind TEAMS_ENABLED: retention is a promise about rows that exist, and
 * rows written while Teams was open must still age out if the flag is turned
 * off. With no organizations the table is empty and a run is one indexed
 * query a day. Teams v1 shipped on 2026-11-14, so no row can reach the window
 * before 2027-12-19.
 */

import { prisma } from "../db.js";
import { recordSchedulerTick, registerScheduler } from "../scheduler-heartbeat.js";
import { createSchedulerLease, type SchedulerLease } from "../scheduler-lease.js";
import { captureError } from "../sentry.js";
import { newWork } from "../work-context.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 400 days: a full annual billing cycle plus ~35 days for disputes and a year-on-year look. */
export const ORG_AUDIT_RETENTION_DAYS = 400;
export const ORG_AUDIT_PURGE_BATCH = 1000;
const MAX_BATCHES_PER_RUN = 50;
export const ORG_AUDIT_PURGE_INTERVAL_MS = DAY_MS;
const FIRST_RUN_DELAY_MS = 10 * 60 * 1000;
const SCHEDULER = "org-audit-retention";

export function orgAuditCutoff(now: Date): Date {
  return new Date(now.getTime() - ORG_AUDIT_RETENTION_DAYS * DAY_MS);
}

export interface PurgeResult {
  deleted: number;
  /** False when the run stopped at MAX_BATCHES_PER_RUN with rows still expired. */
  complete: boolean;
}

/**
 * Delete audit rows strictly older than the cutoff, oldest first, in bounded
 * pages. The delete re-checks the cutoff, so an id can never take a row that
 * is inside the window. Throws on a database error (the tick reports it).
 */
export async function purgeExpiredOrgAuditEvents(
  now: Date = new Date(),
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<PurgeResult> {
  const batchSize = opts.batchSize ?? ORG_AUDIT_PURGE_BATCH;
  const maxBatches = opts.maxBatches ?? MAX_BATCHES_PER_RUN;
  const cutoff = orgAuditCutoff(now);
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const rows = await prisma.orgAuditEvent.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: batchSize,
    });
    if (rows.length === 0) return { deleted, complete: true };
    const { count } = await prisma.orgAuditEvent.deleteMany({
      where: { id: { in: rows.map((row) => row.id) }, createdAt: { lt: cutoff } },
    });
    deleted += count;
    if (rows.length < batchSize) return { deleted, complete: true };
  }
  return { deleted, complete: false };
}

export interface RetentionTickDeps {
  lease: Pick<SchedulerLease, "runExclusive">;
  purge: (now: Date) => Promise<PurgeResult>;
  now: () => Date;
}

let defaultLease: SchedulerLease | null = null;

function defaults(): RetentionTickDeps {
  defaultLease ??= createSchedulerLease({ name: SCHEDULER, logPrefix: "[ORG-AUDIT]" });
  return {
    lease: defaultLease,
    purge: (now) => purgeExpiredOrgAuditEvents(now),
    now: () => new Date(),
  };
}

/**
 * One scheduled run. "skipped" when another instance holds the lease (it does
 * the work, so this one is still alive and records its heartbeat); "failed"
 * records no heartbeat, so a sweep that keeps failing goes stale in the health
 * check as well as reaching Sentry.
 */
export async function orgAuditRetentionTick(
  deps: RetentionTickDeps = defaults(),
): Promise<"ran" | "skipped" | "failed"> {
  try {
    const run: { result?: PurgeResult } = {};
    const ran = await deps.lease.runExclusive(async () => {
      run.result = await deps.purge(deps.now());
    });
    recordSchedulerTick(SCHEDULER);
    const done = run.result;
    if (done && done.deleted > 0) {
      console.log(
        `[ORG-AUDIT] deleted ${done.deleted} audit rows past ${ORG_AUDIT_RETENTION_DAYS}d`,
      );
    }
    if (done && !done.complete) {
      captureError(new Error("org audit retention left a backlog; it continues next run"), {
        tags: { scope: "org-audit-retention.backlog" },
        extra: { deleted: done.deleted },
      });
    }
    return ran ? "ran" : "skipped";
  } catch (err) {
    console.error("[ORG-AUDIT] retention run failed:", err);
    captureError(err, { tags: { scope: "org-audit-retention" } });
    return "failed";
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let firstRunTimer: ReturnType<typeof setTimeout> | null = null;

function tick(): void {
  void orgAuditRetentionTick();
}

export function startOrgAuditRetentionScheduler(): void {
  if (intervalId || firstRunTimer) return;
  registerScheduler(SCHEDULER, ORG_AUDIT_PURGE_INTERVAL_MS);
  firstRunTimer = setTimeout(
    newWork(() => {
      firstRunTimer = null;
      tick();
      intervalId = setInterval(newWork(tick), ORG_AUDIT_PURGE_INTERVAL_MS);
      intervalId.unref?.();
    }),
    FIRST_RUN_DELAY_MS,
  );
  firstRunTimer.unref?.();
}

export function stopOrgAuditRetentionScheduler(): void {
  if (firstRunTimer) {
    clearTimeout(firstRunTimer);
    firstRunTimer = null;
  }
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
