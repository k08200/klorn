import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimeoutError, withTimeout } from "../with-timeout.js";

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("resolves with the underlying value when the work finishes first", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 1000, "fast-work");
    expect(result).toBe("ok");
  });

  it("rejects with the underlying error when the work rejects first", async () => {
    const boom = new Error("boom");
    await expect(withTimeout(Promise.reject(boom), 1000, "failing-work")).rejects.toBe(boom);
  });

  it("rejects with a TimeoutError whose message includes the label after ms", async () => {
    // A promise that never settles — only the timer can win the race.
    const neverResolves = new Promise<never>(() => {});
    const raced = withTimeout(neverResolves, 30_000, "user-42");

    // Attach the assertion before advancing timers so the rejection is handled
    // and does not surface as an unhandled rejection.
    const assertion = expect(raced).rejects.toMatchObject({
      name: "TimeoutError",
      message: expect.stringContaining("user-42"),
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it("does not fire the timer (no dangling timeout) once the work resolves fast", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    await withTimeout(Promise.resolve(123), 5000, "cleared-work");

    // finally clears the timer, so no timers remain pending.
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer even when the work rejects fast", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    await expect(withTimeout(Promise.reject(new Error("x")), 5000, "rejecting")).rejects.toThrow(
      "x",
    );
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exposes TimeoutError as a distinct, instanceof-checkable error type", async () => {
    const neverResolves = new Promise<never>(() => {});
    const raced = withTimeout(neverResolves, 10, "kind-check");
    const assertion = expect(raced).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });
});

// Loop-isolation contract for the scheduler. runUserCycle + runAutomations are
// DB-bound and not exported, so the actual wiring in automation-scheduler.ts is
// covered by inspection. This test pins the SEMANTICS that wiring relies on:
// wrapping each user's cycle in `try { await withTimeout(...) } catch { }` lets
// a hanging or throwing user be isolated while the loop continues to the next.
describe("scheduler loop isolation (withTimeout semantics)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("continues to the next user after one user's cycle hangs past the bound", async () => {
    const processed: string[] = [];
    // Second user hangs forever; the others resolve fast.
    const users: { id: string; cycle: () => Promise<void> }[] = [
      { id: "u1", cycle: async () => void processed.push("u1") },
      { id: "u2", cycle: () => new Promise<void>(() => {}) },
      { id: "u3", cycle: async () => void processed.push("u3") },
    ];
    const skipped: string[] = [];

    const run = (async () => {
      for (const user of users) {
        try {
          await withTimeout(user.cycle(), 30_000, user.id);
        } catch {
          skipped.push(user.id);
        }
      }
    })();

    // Let u1 resolve, then trip u2's timeout so the loop can reach u3.
    await vi.advanceTimersByTimeAsync(30_000);
    await run;

    expect(processed).toEqual(["u1", "u3"]);
    expect(skipped).toEqual(["u2"]);
  });

  it("continues to the next user after one user's cycle throws", async () => {
    const processed: string[] = [];
    const skipped: string[] = [];
    const users: { id: string; cycle: () => Promise<void> }[] = [
      { id: "a", cycle: async () => void processed.push("a") },
      {
        id: "b",
        cycle: async () => {
          throw new Error("cycle exploded");
        },
      },
      { id: "c", cycle: async () => void processed.push("c") },
    ];

    for (const user of users) {
      try {
        await withTimeout(user.cycle(), 30_000, user.id);
      } catch {
        skipped.push(user.id);
      }
    }

    expect(processed).toEqual(["a", "c"]);
    expect(skipped).toEqual(["b"]);
  });
});
