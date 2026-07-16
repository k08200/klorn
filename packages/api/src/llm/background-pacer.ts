/**
 * Global pacer for background-priority LLM calls — the single chokepoint that
 * stops a burst (sync's summarize sweep, batch judge on a 58-email backfill)
 * from slamming the provider's own per-minute quota. When that quota trips,
 * model-fallback locks the provider out for 5–60 minutes and INTERACTIVE
 * calls die too (the PushCard's drafts 503) — so bounding background burst
 * rate is what protects foreground latency, not just background health.
 *
 * Two independent brakes, both env-tunable (config.ts):
 *   - maxConcurrent: how many background calls may be in flight at once.
 *   - minIntervalMs: minimum spacing between background call LAUNCHES,
 *     even when concurrency slots are free.
 *
 * Deliberately global (not per-user): the provider quota being protected is
 * shared by the whole process. Per-user fairness is quota-limiter's job.
 */

import { LLM_BACKGROUND_MAX_CONCURRENT, LLM_BACKGROUND_MIN_INTERVAL_MS } from "../config.js";

export interface BackgroundPacer {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createBackgroundPacer(options: {
  maxConcurrent: number;
  minIntervalMs: number;
}): BackgroundPacer {
  const { maxConcurrent, minIntervalMs } = options;
  let active = 0;
  let nextLaunchAt = 0;
  const waiters: Array<() => void> = [];

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function acquire(): Promise<void> {
    // No await between the check and the increment, so the slot claim is
    // atomic within the event loop.
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    active++;
    const now = Date.now();
    const launchAt = Math.max(now, nextLaunchAt);
    nextLaunchAt = launchAt + minIntervalMs;
    if (launchAt > now) await sleep(launchAt - now);
  }

  function release(): void {
    active--;
    waiters.shift()?.();
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

/** Process-wide pacer used by createCompletion for background-priority calls. */
export const backgroundLlmPacer = createBackgroundPacer({
  maxConcurrent: LLM_BACKGROUND_MAX_CONCURRENT,
  minIntervalMs: LLM_BACKGROUND_MIN_INTERVAL_MS,
});
