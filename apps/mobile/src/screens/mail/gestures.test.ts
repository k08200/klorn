import { describe, expect, it, vi } from "vitest";
import {
  armedAction,
  COMMIT_DISTANCE,
  crossedThreshold,
  rowOffset,
  swipeIntent,
  swipeOutcome,
  VelocityTracker,
} from "./swipe";
import { UNDO_WINDOW_MS, UndoQueue } from "./undo-queue";

describe("swipe thresholds", () => {
  it("waits for a clear direction before claiming the gesture", () => {
    expect(swipeIntent(3, 2)).toBe("pending");
    expect(swipeIntent(20, 4)).toBe("horizontal");
    expect(swipeIntent(-20, 4)).toBe("horizontal");
    // Diagonal-ish scrolls stay with the list (and pull-to-refresh).
    expect(swipeIntent(12, 10)).toBe("vertical");
    expect(swipeIntent(2, 30)).toBe("vertical");
  });

  it("commits past the 88px reveal in either direction", () => {
    expect(COMMIT_DISTANCE).toBe(88);
    expect(swipeOutcome(87, 0)).toBe("cancel");
    expect(swipeOutcome(88, 0)).toBe("done");
    expect(swipeOutcome(-88, 0)).toBe("lane");
    expect(swipeOutcome(200, -1)).toBe("done");
  });

  it("commits a fast fling from a shorter drag, only in the drag's direction", () => {
    expect(swipeOutcome(50, 0.8)).toBe("done");
    expect(swipeOutcome(-50, -0.8)).toBe("lane");
    expect(swipeOutcome(50, -0.8)).toBe("cancel");
    expect(swipeOutcome(30, 2)).toBe("cancel");
    expect(swipeOutcome(60, 0.3)).toBe("cancel");
  });

  it("reports one crossing per threshold pass (one haptic)", () => {
    expect(crossedThreshold(80, 90)).toBe(true);
    expect(crossedThreshold(90, 120)).toBe(false);
    expect(crossedThreshold(95, 70)).toBe(true);
    expect(crossedThreshold(-80, -90)).toBe(true);
    expect(armedAction(-120)).toBe("lane");
  });

  it("follows the finger 1:1, then with resistance", () => {
    expect(rowOffset(100)).toBe(100);
    expect(rowOffset(240)).toBeLessThan(240);
    expect(rowOffset(-240)).toBeGreaterThan(-240);
  });

  it("measures velocity over the last 100ms", () => {
    const v = new VelocityTracker();
    v.add(0, 0);
    v.add(10, 50);
    v.add(70, 150);
    v.add(130, 200);
    expect(v.velocity()).toBeCloseTo(1.2, 1);
  });
});

describe("undo window", () => {
  const timers = () => {
    vi.useFakeTimers();
    return {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
  };

  it("sends a deferred commit only after 5 seconds", async () => {
    const q = new UndoQueue(UNDO_WINDOW_MS, timers());
    const commit = vi.fn(async () => {});
    q.push({ id: "a", message: "m", kind: "deferred", commit, revert: () => {} });
    expect(q.getSnapshot().current?.id).toBe("a");
    vi.advanceTimersByTime(4_999);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(q.getSnapshot().current).toBeNull();
    vi.useRealTimers();
  });

  it("undo inside the window never sends and puts the row back", async () => {
    const q = new UndoQueue(UNDO_WINDOW_MS, timers());
    const commit = vi.fn(async () => {});
    const revert = vi.fn();
    q.push({ id: "a", message: "m", kind: "deferred", commit, revert });
    vi.advanceTimersByTime(3_000);
    expect(await q.undo()).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(commit).not.toHaveBeenCalled();
    expect(revert).toHaveBeenCalledTimes(1);
    expect(await q.undo()).toBe(false);
    vi.useRealTimers();
  });

  it("flushes everything still waiting when the app leaves", () => {
    const q = new UndoQueue(UNDO_WINDOW_MS, timers());
    const a = vi.fn(async () => {});
    const b = vi.fn(async () => {});
    q.push({ id: "a", message: "m", kind: "deferred", commit: a, revert: () => {} });
    q.push({ id: "b", message: "m", kind: "deferred", commit: b, revert: () => {} });
    expect(q.getSnapshot().current).toMatchObject({ id: "b", count: 2 });
    q.flush();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(q.size).toBe(0);
    vi.useRealTimers();
  });

  it("puts the row back and reports when the commit fails", async () => {
    vi.useRealTimers();
    const q = new UndoQueue(10);
    const revert = vi.fn();
    const onCommitError = vi.fn();
    q.push({
      id: "a",
      message: "m",
      kind: "deferred",
      commit: () => Promise.reject(new Error("500")),
      revert,
      onCommitError,
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(revert).toHaveBeenCalledTimes(1);
    expect(onCommitError).toHaveBeenCalledTimes(1);
  });

  it("an applied entry's undo runs the reversal; expiry changes nothing", async () => {
    const q = new UndoQueue(UNDO_WINDOW_MS, timers());
    const revert = vi.fn(async () => {});
    q.push({ id: "m", message: "moved", kind: "applied", revert });
    await q.undo("m");
    expect(revert).toHaveBeenCalledTimes(1);
    q.push({ id: "n", message: "moved", kind: "applied", revert });
    vi.advanceTimersByTime(UNDO_WINDOW_MS);
    expect(revert).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("notifies subscribers on every change", () => {
    const q = new UndoQueue(UNDO_WINDOW_MS, timers());
    const listener = vi.fn();
    const off = q.subscribe(listener);
    q.push({ id: "a", message: "m", kind: "applied", revert: () => {} });
    q.dismissCurrent();
    off();
    q.push({ id: "b", message: "m", kind: "applied", revert: () => {} });
    expect(listener).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
