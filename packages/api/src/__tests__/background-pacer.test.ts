/**
 * Background LLM pacer — the burst-control chokepoint for every
 * background-priority completion (summarize sweep, batch judge, briefing).
 * Without it a single /sync fires 10+ concurrent provider calls, trips the
 * free-tier per-minute quota, and the resulting provider cooldown locks out
 * INTERACTIVE calls too (PushCard drafts 503 for 5+ minutes).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackgroundPacer } from "../llm/background-pacer.js";

describe("background-pacer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never runs more than maxConcurrent tasks at once", async () => {
    const pacer = createBackgroundPacer({ maxConcurrent: 2, minIntervalMs: 0 });
    let running = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];
    const task = () =>
      new Promise<void>((resolve) => {
        running++;
        peak = Math.max(peak, running);
        resolvers.push(() => {
          running--;
          resolve();
        });
      });

    const all = Promise.all(Array.from({ length: 5 }, () => pacer.run(task)));
    await vi.advanceTimersByTimeAsync(1);
    expect(peak).toBe(2);

    while (resolvers.length > 0) {
      resolvers.shift()?.();
      await vi.advanceTimersByTimeAsync(1);
    }
    await all;
    expect(peak).toBe(2);
  });

  it("spaces launches by minIntervalMs even when slots are free", async () => {
    const pacer = createBackgroundPacer({ maxConcurrent: 10, minIntervalMs: 4_000 });
    const starts: number[] = [];
    const task = async () => {
      starts.push(Date.now());
    };

    const all = Promise.all([pacer.run(task), pacer.run(task), pacer.run(task)]);
    await vi.advanceTimersByTimeAsync(10_000);
    await all;

    expect(starts.length).toBe(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(4_000);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(4_000);
  });

  it("releases the slot when a task throws, so the queue never wedges", async () => {
    const pacer = createBackgroundPacer({ maxConcurrent: 1, minIntervalMs: 0 });
    const boom = pacer.run(async () => {
      throw new Error("provider down");
    });
    await expect(boom).rejects.toThrow("provider down");

    let ran = false;
    const next = pacer.run(async () => {
      ran = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(ran).toBe(true);
  });

  it("propagates the task's return value", async () => {
    const pacer = createBackgroundPacer({ maxConcurrent: 1, minIntervalMs: 0 });
    const result = pacer.run(async () => 42);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(42);
  });
});
