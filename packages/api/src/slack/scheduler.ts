/**
 * The Slack scheduler (docs/providers/slack.md §3, §11): every 30 s, under the
 * "slack-episodes" row lease so only one instance works at a time.
 *
 * - The retention purge runs at most every 10 minutes and runs even while
 *   SLACK_ENABLED is off: switching the flag off must not stop stored Slack
 *   text from expiring.
 * - While the flag is off, ticks between purges touch no database at all.
 */

import { slackLive } from "../config.js";
import { recordSchedulerTick, registerScheduler } from "../scheduler-heartbeat.js";
import { createSchedulerLease } from "../scheduler-lease.js";
import { captureError } from "../sentry.js";
import { newWork } from "../work-context.js";
import { purgeExpiredSlackData } from "./purge.js";

export const SLACK_SCHEDULER_INTERVAL_MS = 30_000;
export const SLACK_PURGE_INTERVAL_MS = 10 * 60_000;
const LOG_PREFIX = "[SLACK]";

const slackLease = createSchedulerLease({ name: "slack-episodes", logPrefix: LOG_PREFIX });
let lastPurgeAt = 0;

/** Test seam: forget when the last purge ran. */
export function resetSlackSchedulerState(): void {
  lastPurgeAt = 0;
}

/** One tick's work, run under the lease. */
export async function runSlackWork(now: Date = new Date()): Promise<void> {
  if (now.getTime() - lastPurgeAt >= SLACK_PURGE_INTERVAL_MS) {
    const purged = await purgeExpiredSlackData(now);
    lastPurgeAt = now.getTime();
    if (purged.messages > 0 || purged.episodes > 0) {
      console.log(
        `${LOG_PREFIX} retention: deleted ${purged.messages} messages, ${purged.episodes} episodes`,
      );
    }
  }
}

export async function slackSchedulerTick(
  now: Date = new Date(),
  lease: { runExclusive(work: () => Promise<void>): Promise<boolean> } = slackLease,
): Promise<void> {
  try {
    const purgeDue = now.getTime() - lastPurgeAt >= SLACK_PURGE_INTERVAL_MS;
    if (slackLive() || purgeDue) await lease.runExclusive(() => runSlackWork(now));
    recordSchedulerTick("slack-episodes");
  } catch (err) {
    console.error(`${LOG_PREFIX} tick failed:`, err);
    captureError(err, { tags: { scope: "slack.scheduler" } });
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startSlackScheduler(): void {
  if (intervalId) return;
  registerScheduler("slack-episodes", SLACK_SCHEDULER_INTERVAL_MS);
  intervalId = setInterval(
    newWork(() => {
      void slackSchedulerTick();
    }),
    SLACK_SCHEDULER_INTERVAL_MS,
  );
  intervalId.unref?.();
}

export function stopSlackScheduler(): void {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
}
