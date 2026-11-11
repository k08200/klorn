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
 * The slot limits are deliberately global: the provider quota being protected
 * is shared by the whole process. The QUEUE is not: calls wait in one lane per
 * user and freed slots go round-robin across lanes. With a single FIFO, one
 * user's mail flood queued thousands of calls ahead of everyone else and
 * stalled every user's background work (judge, summaries, agent).
 */

import { LLM_BACKGROUND_MAX_CONCURRENT, LLM_BACKGROUND_MIN_INTERVAL_MS } from "../config.js";

export interface PacerLoad {
  active: number;
  waiting: number;
  maxConcurrent: number;
}

/** Lane for calls that name none (system work, and older callers). */
export const DEFAULT_PACER_LANE = "system";

/** How many lanes' last-served times the pacer remembers (bounds its memory). */
export const MAX_REMEMBERED_LANES = 1024;

export interface BackgroundPacer {
  /**
   * Run fn when a slot is free. `lane` is the caller's fairness key (the user
   * id): waiting calls are served round-robin across lanes, FIFO within one.
   */
  run<T>(fn: () => Promise<T>, lane?: string): Promise<T>;
  /** Calls in flight and calls queued for a slot, for callers that would rather skip than wait. */
  load(): PacerLoad;
  /**
   * Run fn only if a slot is free right now, nobody is queued and the launch
   * spacing allows it; otherwise null, without queueing. For work that must
   * never wait behind (or delay) the calls that do queue.
   */
  tryRun<T>(fn: () => Promise<T>, lane?: string): Promise<T> | null;
}

export function createBackgroundPacer(options: {
  maxConcurrent: number;
  minIntervalMs: number;
}): BackgroundPacer {
  const { maxConcurrent, minIntervalMs } = options;
  let active = 0;
  let nextLaunchAt = 0;
  let waiting = 0;
  // Queued calls per lane, FIFO inside a lane. Map order breaks ties.
  const queued = new Map<string, Array<() => void>>();
  // Per lane: calls in flight, and when it was last handed a slot. A freed
  // slot goes to the queued lane served least recently, so a user whose call
  // just ran goes behind every other waiting user. `lastServed` must outlive a
  // lane's idle moments: a user who calls one at a time is idle between calls,
  // and forgetting them would put them back at the front every time and starve
  // a user with a backlog. It is kept in serve order and trimmed to the most
  // recent MAX_REMEMBERED_LANES; a forgotten lane can only be one idle longer
  // than every remembered lane, so treating it as never served is fair.
  const inFlight = new Map<string, number>();
  const lastServed = new Map<string, number>();
  let serveCount = 0;

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  function markServed(lane: string): void {
    serveCount++;
    // Re-insert so Map order stays oldest-served first.
    lastServed.delete(lane);
    lastServed.set(lane, serveCount);
    inFlight.set(lane, (inFlight.get(lane) ?? 0) + 1);
    forgetOldestIdleLanes();
  }

  function forgetOldestIdleLanes(): void {
    if (lastServed.size <= MAX_REMEMBERED_LANES) return;
    for (const lane of lastServed.keys()) {
      if (lastServed.size <= MAX_REMEMBERED_LANES) return;
      if (!inFlight.has(lane) && !queued.has(lane)) lastServed.delete(lane);
    }
  }

  function markDone(lane: string): void {
    const left = (inFlight.get(lane) ?? 1) - 1;
    if (left > 0) inFlight.set(lane, left);
    else inFlight.delete(lane);
  }

  function enqueue(lane: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const queue = queued.get(lane);
      if (queue) queue.push(resolve);
      else queued.set(lane, [resolve]);
      waiting++;
    });
  }

  /** Hands the slot to the least recently served queued lane; false if none. */
  function handOff(): boolean {
    let pick: string | undefined;
    let pickServed = Number.POSITIVE_INFINITY;
    for (const lane of queued.keys()) {
      const served = lastServed.get(lane) ?? 0;
      if (served < pickServed) {
        pick = lane;
        pickServed = served;
      }
    }
    if (pick === undefined) return false;
    const queue = queued.get(pick) ?? [];
    const next = queue.shift();
    if (queue.length === 0) queued.delete(pick);
    waiting--;
    markServed(pick);
    next?.();
    return true;
  }

  async function acquire(lane: string): Promise<void> {
    // No await between the check and the claim, so the slot claim is atomic
    // within the event loop. A queued call is handed the releasing call's slot
    // directly (release() does not decrement), so `active` never dips below
    // the real count and no other caller can take the slot in between.
    if (active >= maxConcurrent || waiting > 0) {
      await enqueue(lane);
    } else {
      active++;
      markServed(lane);
    }
    const now = Date.now();
    const launchAt = Math.max(now, nextLaunchAt);
    nextLaunchAt = launchAt + minIntervalMs;
    if (launchAt > now) await sleep(launchAt - now);
  }

  function release(lane: string): void {
    markDone(lane);
    if (!handOff()) active--;
  }

  async function runHeld<T>(fn: () => Promise<T>, lane: string): Promise<T> {
    try {
      return await fn();
    } finally {
      release(lane);
    }
  }

  return {
    load: () => ({ active, waiting, maxConcurrent }),
    async run<T>(fn: () => Promise<T>, lane: string = DEFAULT_PACER_LANE): Promise<T> {
      await acquire(lane);
      return runHeld(fn, lane);
    },
    tryRun<T>(fn: () => Promise<T>, lane: string = DEFAULT_PACER_LANE): Promise<T> | null {
      const now = Date.now();
      if (active >= maxConcurrent || waiting > 0 || now < nextLaunchAt) return null;
      active++;
      markServed(lane);
      nextLaunchAt = now + minIntervalMs;
      return runHeld(fn, lane);
    },
  };
}

/** Process-wide pacer used by createCompletion for background-priority calls. */
export const backgroundLlmPacer = createBackgroundPacer({
  maxConcurrent: LLM_BACKGROUND_MAX_CONCURRENT,
  minIntervalMs: LLM_BACKGROUND_MIN_INTERVAL_MS,
});
