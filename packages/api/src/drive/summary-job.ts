/**
 * The summary job (step D4 of docs/providers/unified-platform-plan.md). Every
 * DRIVE_SUMMARY_INTERVAL_MS it runs the due PENDING rows: at most
 * DRIVE_SUMMARY_BATCH runs, at most DRIVE_SUMMARY_PER_USER_PER_SWEEP of one user,
 * one after the other, each claimed first (summary-store.ts). A run's own
 * outcome sets the row's next attempt (summary-run.ts); a run that throws is
 * reported and its lease lets it be taken again later.
 *
 * Off (DRIVE_SUMMARIES_ENABLED or DRIVE_ENABLED, read per sweep): the sweep reads
 * nothing and claims nothing. The scheduler still registers its heartbeat, so the
 * flag can flip without a restart and the health check never reports it missing.
 * Like every scheduler it is not started while BACKGROUND_AGENTS_DISABLED is set.
 *
 * One sweep at a time per process: a tick that finds the previous sweep running
 * does nothing. Across processes the claim keeps two from running the same row.
 */

import { recordSchedulerTick, registerScheduler } from "../scheduler-heartbeat.js";
import { captureError } from "../sentry.js";
import { driveSummariesLive } from "./summary-policy.js";
import { runClaimedSummary, type SummaryRunOutcome } from "./summary-run.js";
import { claimSummary, dueSummaries, pruneSummaryUsage } from "./summary-store.js";

export const DRIVE_SUMMARY_INTERVAL_MS = 5 * 60_000;
/** Runs per sweep: 10 every 5 minutes is at most 120 model calls an hour, fleet-wide. */
export const DRIVE_SUMMARY_BATCH = 10;
/** Runs of one user per sweep, so one large upload does not hold everyone else back. */
export const DRIVE_SUMMARY_PER_USER_PER_SWEEP = 3;
/** Due rows read per sweep, so the per-user bound still leaves a full batch. */
const DUE_READ = DRIVE_SUMMARY_BATCH * 4;
const FIRST_SWEEP_DELAY_MS = 2 * 60_000;

export interface SummarySweepResult {
  state: "off" | "busy" | "ran";
  runs: number;
  done: number;
  failed: number;
}

let running = false;

function emptyResult(state: SummarySweepResult["state"]): SummarySweepResult {
  return { state, runs: 0, done: 0, failed: 0 };
}

async function runSafely(row: Parameters<typeof runClaimedSummary>[0], now: Date) {
  try {
    return await runClaimedSummary(row, { priority: "background", now });
  } catch (err) {
    console.error("[DRIVE] summary run failed; the row is retried after its lease");
    captureError(err, { tags: { scope: "drive.summary.sweep" }, extra: { userId: row.userId } });
    return "failed" satisfies SummaryRunOutcome;
  }
}

async function sweepDue(clock: () => Date): Promise<SummarySweepResult> {
  const result: SummarySweepResult = emptyResult("ran");
  const start = clock();
  await pruneSummaryUsage(start);
  const perUser = new Map<string, number>();
  for (const row of await dueSummaries(start, DUE_READ)) {
    if (result.runs >= DRIVE_SUMMARY_BATCH) break;
    const taken = perUser.get(row.userId) ?? 0;
    if (taken >= DRIVE_SUMMARY_PER_USER_PER_SWEEP) continue;
    const now = clock();
    if (!(await claimSummary(row, now))) continue;
    perUser.set(row.userId, taken + 1);
    const outcome = await runSafely(row, now);
    result.runs += 1;
    if (outcome === "done") result.done += 1;
    if (outcome === "failed") result.failed += 1;
  }
  return result;
}

/** One sweep. `now` pins the clock (tests); the job passes nothing. */
export async function runDriveSummarySweep(now?: Date): Promise<SummarySweepResult> {
  if (!driveSummariesLive()) return emptyResult("off");
  if (running) return emptyResult("busy");
  running = true;
  try {
    const result = await sweepDue(() => now ?? new Date());
    if (result.runs > 0) {
      console.log(
        `[DRIVE] summary sweep: ${result.runs} runs, ${result.done} done, ${result.failed} failed`,
      );
    }
    return result;
  } finally {
    running = false;
  }
}

/** One scheduled sweep; the heartbeat is recorded when a sweep ends (not when busy). */
export async function driveSummaryTick(): Promise<void> {
  try {
    const result = await runDriveSummarySweep();
    if (result.state !== "busy") recordSchedulerTick("drive-summary");
  } catch (err) {
    console.error("[DRIVE] summary sweep failed:", err);
    captureError(err, { tags: { scope: "drive.summary.sweep" } });
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let firstRunTimer: ReturnType<typeof setTimeout> | null = null;

function tick(): void {
  void driveSummaryTick();
}

export function startDriveSummaryScheduler(): void {
  if (intervalId || firstRunTimer) return;
  registerScheduler("drive-summary", DRIVE_SUMMARY_INTERVAL_MS);
  firstRunTimer = setTimeout(() => {
    firstRunTimer = null;
    tick();
    intervalId = setInterval(tick, DRIVE_SUMMARY_INTERVAL_MS);
    intervalId.unref?.();
  }, FIRST_SWEEP_DELAY_MS);
  firstRunTimer.unref?.();
}

export function stopDriveSummaryScheduler(): void {
  if (firstRunTimer) clearTimeout(firstRunTimer);
  if (intervalId) clearInterval(intervalId);
  firstRunTimer = null;
  intervalId = null;
}
