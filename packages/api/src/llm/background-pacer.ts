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

export interface PacerLoad {
  active: number;
  waiting: number;
  maxConcurrent: number;
}

export interface BackgroundPacer {
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Calls in flight and calls queued for a slot, for callers that would rather skip than wait. */
  load(): PacerLoad;
  /**
   * Run fn only if a slot is free right now, nobody is queued and the launch
   * spacing allows it; otherwise null, without queueing. For work that must
   * never wait behind (or delay) the calls that do queue.
   */
  tryRun<T>(fn: () => Promise<T>): Promise<T> | null;
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
    // atomic within the event loop. A waiter is handed the releasing call's
    // slot directly (release() does not decrement), so `active` never dips
    // below the real count and no other caller can take the slot in between.
    if (active >= maxConcurrent || waiters.length > 0) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    } else {
      active++;
    }
    const now = Date.now();
    const launchAt = Math.max(now, nextLaunchAt);
    nextLaunchAt = launchAt + minIntervalMs;
    if (launchAt > now) await sleep(launchAt - now);
  }

  function release(): void {
    const next = waiters.shift();
    if (next) next();
    else active--;
  }

  async function runHeld<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return {
    load: () => ({ active, waiting: waiters.length, maxConcurrent }),
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      return runHeld(fn);
    },
    tryRun<T>(fn: () => Promise<T>): Promise<T> | null {
      const now = Date.now();
      if (active >= maxConcurrent || waiters.length > 0 || now < nextLaunchAt) return null;
      active++;
      nextLaunchAt = now + minIntervalMs;
      return runHeld(fn);
    },
  };
}

/** Process-wide pacer used by createCompletion for background-priority calls. */
export const backgroundLlmPacer = createBackgroundPacer({
  maxConcurrent: LLM_BACKGROUND_MAX_CONCURRENT,
  minIntervalMs: LLM_BACKGROUND_MIN_INTERVAL_MS,
});
