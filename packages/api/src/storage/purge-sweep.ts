/**
 * The hourly purge sweep (step D3 of docs/providers/unified-platform-plan.md).
 * It finishes what a deletion started: every due StoragePurge record gets one
 * pass (storage/durable-purge.ts). A failed pass is retried with backoff
 * (purge-queue.ts); a pass that started after the late-upload grace and emptied
 * the prefix deletes the record.
 *
 * Off (OBJECT_STORAGE_ENABLED, read per tick): a tick reads nothing. The
 * scheduler still registers its heartbeat, so the flag can flip without a
 * restart and the health check never reports it missing. Like every scheduler
 * it is not started while BACKGROUND_AGENTS_DISABLED is set; pending purges then
 * wait (a deletion's own first pass still runs).
 *
 * One sweep at a time: a tick that finds the previous sweep still running does
 * nothing. A sweep handles at most PURGE_SWEEP_BATCH records, one after the
 * other, and each pass is bounded by PURGE_DEADLINE_MS, so a sweep ends well
 * inside its interval even against a bucket that times out on every call.
 *
 * Runs on the global client. When the app role drops BYPASSRLS it moves to
 * `withSystem` (db-tenant.ts): the sweep reads every user's record.
 */

import { objectStorageEnabled } from "../config.js";
import { recordSchedulerTick, registerScheduler } from "../scheduler-heartbeat.js";
import { captureError } from "../sentry.js";
import { duePurges, PURGE_RETRY_BASE_MS } from "./purge-queue.js";

/** The sweep runs once an hour; the first retry waits exactly one sweep. */
export const PURGE_SWEEP_INTERVAL_MS = PURGE_RETRY_BASE_MS;
/** Let the server finish booting before the first sweep. */
const FIRST_SWEEP_DELAY_MS = 5 * 60_000;
/**
 * Records one sweep handles. 25 passes of at most PURGE_DEADLINE_MS (45 s,
 * user-storage.ts) is under 19 minutes, well inside the hour; the rest wait for
 * the next sweep.
 */
export const PURGE_SWEEP_BATCH = 25;

export interface PurgeSweepResult {
  state: "off" | "busy" | "ran";
  passes: number;
  done: number;
  failed: number;
}

let running = false;

async function sweepDue(): Promise<PurgeSweepResult> {
  const { runPurgePass } = await import("./durable-purge.js");
  const result: PurgeSweepResult = { state: "ran", passes: 0, done: 0, failed: 0 };
  for (const userId of await duePurges(new Date(), PURGE_SWEEP_BATCH)) {
    const pass = await runPurgePass(userId);
    result.passes += 1;
    if (pass.outcome === "done") result.done += 1;
    if (pass.outcome === "failed") result.failed += 1;
  }
  return result;
}

/** One sweep over the due records. A pass that cannot record its outcome throws. */
export async function runStoragePurgeSweep(): Promise<PurgeSweepResult> {
  if (!objectStorageEnabled()) return { state: "off", passes: 0, done: 0, failed: 0 };
  if (running) return { state: "busy", passes: 0, done: 0, failed: 0 };
  running = true;
  try {
    const result = await sweepDue();
    if (result.passes > 0) {
      console.log(
        `[STORAGE] purge sweep: ${result.passes} passes, ${result.done} finished, ${result.failed} failed`,
      );
    }
    return result;
  } finally {
    running = false;
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let firstRunTimer: ReturnType<typeof setTimeout> | null = null;

function tick(): void {
  recordSchedulerTick("storage-purge");
  runStoragePurgeSweep().catch((err) => {
    console.error("[STORAGE] purge sweep failed:", err);
    captureError(err, { tags: { scope: "storage.purge.sweep" } });
  });
}

export function startStoragePurgeScheduler(): void {
  if (intervalId || firstRunTimer) return;
  registerScheduler("storage-purge", PURGE_SWEEP_INTERVAL_MS);
  firstRunTimer = setTimeout(() => {
    firstRunTimer = null;
    tick();
    intervalId = setInterval(tick, PURGE_SWEEP_INTERVAL_MS);
    intervalId.unref?.();
  }, FIRST_SWEEP_DELAY_MS);
  firstRunTimer.unref?.();
}

export function stopStoragePurgeScheduler(): void {
  if (firstRunTimer) {
    clearTimeout(firstRunTimer);
    firstRunTimer = null;
  }
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
