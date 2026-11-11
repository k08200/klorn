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

describe("backgroundPacer load() and tryRun()", () => {
  const gate = () => {
    let open: () => void = () => {};
    const p = new Promise<void>((r) => {
      open = r;
    });
    return { p, open };
  };

  it("reports calls in flight and calls waiting for a slot", async () => {
    const { createBackgroundPacer } = await import("../llm/background-pacer.js");
    const pacer = createBackgroundPacer({ maxConcurrent: 1, minIntervalMs: 0 });
    expect(pacer.load()).toEqual({ active: 0, waiting: 0, maxConcurrent: 1 });
    const g = gate();
    const first = pacer.run(() => g.p);
    const second = pacer.run(async () => undefined);
    await vi.waitFor(() =>
      expect(pacer.load()).toEqual({ active: 1, waiting: 1, maxConcurrent: 1 }),
    );
    g.open();
    await first;
    await second;
    expect(pacer.load()).toEqual({ active: 0, waiting: 0, maxConcurrent: 1 });
  });

  it("tryRun claims a free slot at once, or returns null without queueing", async () => {
    const { createBackgroundPacer } = await import("../llm/background-pacer.js");
    const pacer = createBackgroundPacer({ maxConcurrent: 1, minIntervalMs: 0 });
    const g = gate();
    const held = pacer.tryRun(() => g.p);
    expect(held).not.toBeNull();
    expect(pacer.tryRun(async () => "never")).toBeNull();
    expect(pacer.load().waiting).toBe(0);
    g.open();
    await held;
    expect(await pacer.tryRun(async () => "next")).toBe("next");
  });

  it("tryRun never jumps a queue, and never launches inside the spacing window", async () => {
    const { createBackgroundPacer } = await import("../llm/background-pacer.js");
    const spaced = createBackgroundPacer({ maxConcurrent: 2, minIntervalMs: 60_000 });
    await spaced.run(async () => undefined);
    expect(spaced.tryRun(async () => "too soon")).toBeNull();

    const pacer = createBackgroundPacer({ maxConcurrent: 1, minIntervalMs: 0 });
    const g = gate();
    const first = pacer.run(() => g.p);
    const queued = pacer.run(async () => "queued");
    await vi.waitFor(() => expect(pacer.load().waiting).toBe(1));
    expect(pacer.tryRun(async () => "jump")).toBeNull();
    g.open();
    await first;
    expect(await queued).toBe("queued");
  });

  it("hands a released slot straight to the next waiter: never over the limit", async () => {
    const { createBackgroundPacer } = await import("../llm/background-pacer.js");
    const pacer = createBackgroundPacer({ maxConcurrent: 1, minIntervalMs: 0 });
    let peak = 0;
    const track = async () => {
      peak = Math.max(peak, pacer.load().active);
      await Promise.resolve();
    };
    const g = gate();
    const first = pacer.run(async () => {
      await g.p;
      await track();
    });
    const second = pacer.run(track);
    await vi.waitFor(() => expect(pacer.load().waiting).toBe(1));
    g.open();
    await first;
    // In the hand-off window a tryRun must not squeeze in.
    expect(pacer.tryRun(async () => "squeeze")).toBeNull();
    await second;
    expect(peak).toBe(1);
  });
});

describe("backgroundPacer per-user lanes", () => {
  const gate = () => {
    let open: () => void = () => {};
    const p = new Promise<void>((r) => {
      open = r;
    });
    return { p, open };
  };

  it("serves a second user's call before the flooding user's backlog", async () => {
    const pacer = createBackgroundPacer({ maxConcurrent: 1, minIntervalMs: 0 });
    const order: string[] = [];
    const g = gate();
    const first = pacer.run(async () => {
      await g.p;
      order.push("a0");
    }, "user-a");
    const flood = Array.from({ length: 50 }, (_, i) =>
      pacer.run(async () => {
        order.push(`a${i + 1}`);
      }, "user-a"),
    );
    const other = pacer.run(async () => {
      order.push("b0");
    }, "user-b");
    await vi.waitFor(() => expect(pacer.load().waiting).toBe(51));

    g.open();
    await Promise.all([first, other, ...flood]);

    expect(order.slice(0, 3)).toEqual(["a0", "b0", "a1"]);
    expect(order).toHaveLength(52);
  });

  it("hands each freed slot to the waiting user served least recently", async () => {
    const pacer = createBackgroundPacer({ maxConcurrent: 1, minIntervalMs: 0 });
    const order: string[] = [];
    const g = gate();
    const held = pacer.run(() => g.p, "user-a");
    const jobs = [
      ["user-a", "a1"],
      ["user-a", "a2"],
      ["user-b", "b1"],
      ["user-b", "b2"],
      ["user-c", "c1"],
    ].map(([lane, tag]) =>
      pacer.run(async () => {
        order.push(tag);
      }, lane),
    );
    await vi.waitFor(() => expect(pacer.load().waiting).toBe(5));

    g.open();
    await Promise.all([held, ...jobs]);

    // user-a just had a call run, so b and c go first; then strict rotation.
    expect(order).toEqual(["b1", "c1", "a1", "b2", "a2"]);
  });

  it("keeps calls without a lane in one shared lane, in FIFO order", async () => {
    const pacer = createBackgroundPacer({ maxConcurrent: 1, minIntervalMs: 0 });
    const order: number[] = [];
    const g = gate();
    const held = pacer.run(() => g.p);
    const jobs = [1, 2, 3].map((n) =>
      pacer.run(async () => {
        order.push(n);
      }),
    );
    await vi.waitFor(() => expect(pacer.load().waiting).toBe(3));

    g.open();
    await Promise.all([held, ...jobs]);

    expect(order).toEqual([1, 2, 3]);
  });

  it("still never exceeds maxConcurrent across lanes", async () => {
    const pacer = createBackgroundPacer({ maxConcurrent: 2, minIntervalMs: 0 });
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 6 }, gate);
    const jobs = gates.map((g, i) =>
      pacer.run(
        async () => {
          running++;
          peak = Math.max(peak, running);
          await g.p;
          running--;
        },
        `user-${i % 3}`,
      ),
    );
    await vi.waitFor(() => expect(pacer.load().active).toBe(2));
    for (const g of gates) g.open();
    await Promise.all(jobs);

    expect(peak).toBe(2);
    expect(pacer.load()).toEqual({ active: 0, waiting: 0, maxConcurrent: 2 });
  });

  it("keeps a backlogged user's share while other users call one at a time", async () => {
    // Users who submit, await, then submit again are briefly idle between
    // calls. Forgetting when an idle user was last served would put them back
    // at the front every time and starve a user with a queued backlog.
    const pacer = createBackgroundPacer({ maxConcurrent: 2, minIntervalMs: 0 });
    let backlogServed = 0;
    const backlog = Array.from({ length: 100 }, () =>
      pacer.run(async () => {
        backlogServed++;
        await new Promise((r) => setImmediate(r));
      }, "user-backlog"),
    );
    const loop = async (lane: string) => {
      for (let i = 0; i < 100; i++) {
        await pacer.run(async () => {
          await new Promise((r) => setImmediate(r));
        }, lane);
      }
    };
    await Promise.all([loop("user-b"), loop("user-c"), loop("user-d")]);
    const servedWhileOthersRan = backlogServed;
    await Promise.all(backlog);

    expect(servedWhileOthersRan).toBeGreaterThanOrEqual(50);
  });
});
