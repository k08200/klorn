import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LLM_USER_BACKGROUND_DAILY_CAP,
  LLM_USER_DAILY_CAP,
  LLM_USER_FOREGROUND_DAILY_CAP,
  LLM_USER_RPM,
} from "../config.js";
import {
  _resetAllUserWindowsForTests,
  checkAndRecordUserCall,
  getUserUsage,
  UserRateLimitedError,
} from "../quota-limiter.js";

describe("quota-limiter", () => {
  beforeEach(() => {
    _resetAllUserWindowsForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 24, 12, 0, 0)));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows calls under the RPM cap", () => {
    for (let i = 0; i < LLM_USER_RPM; i++) {
      expect(() => checkAndRecordUserCall("u1")).not.toThrow();
    }
  });

  it("rejects with UserRateLimitedError(rpm) when the per-minute cap is exceeded", () => {
    for (let i = 0; i < LLM_USER_RPM; i++) checkAndRecordUserCall("u1");
    let caught: unknown;
    try {
      checkAndRecordUserCall("u1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UserRateLimitedError);
    const err = caught as UserRateLimitedError;
    expect(err.reason).toBe("rpm");
    expect(err.retryAfterMs).toBeGreaterThan(0);
    expect(err.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("resets the RPM bucket as the 60s sliding window passes", () => {
    for (let i = 0; i < LLM_USER_RPM; i++) checkAndRecordUserCall("u1");
    expect(() => checkAndRecordUserCall("u1")).toThrow(UserRateLimitedError);
    vi.advanceTimersByTime(60_001);
    expect(() => checkAndRecordUserCall("u1")).not.toThrow();
  });

  it("keeps separate buckets per user", () => {
    for (let i = 0; i < LLM_USER_RPM; i++) checkAndRecordUserCall("u1");
    expect(() => checkAndRecordUserCall("u1")).toThrow();
    expect(() => checkAndRecordUserCall("u2")).not.toThrow();
  });

  /**
   * Spreads `count` calls of the given priority for `userId` across enough
   * fake-time gaps that the per-minute RPM window never trips. Keeps each
   * daily-bucket test focused on the daily counter only.
   */
  function fillBucket(userId: string, priority: "foreground" | "background", count: number): void {
    // Drain any RPM debt left over from a previous fill before starting.
    vi.advanceTimersByTime(61_000);
    for (let i = 0; i < count; i++) {
      checkAndRecordUserCall(userId, { priority });
      if (i % LLM_USER_RPM === LLM_USER_RPM - 1) vi.advanceTimersByTime(61_000);
    }
  }

  it("caps foreground calls at LLM_USER_FOREGROUND_DAILY_CAP without affecting background", () => {
    fillBucket("heavy-fg", "foreground", LLM_USER_FOREGROUND_DAILY_CAP);

    let caught: unknown;
    try {
      checkAndRecordUserCall("heavy-fg", { priority: "foreground" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UserRateLimitedError);
    const err = caught as UserRateLimitedError;
    expect(err.reason).toBe("daily");
    expect(err.priority).toBe("foreground");

    // Background bucket is still wide open
    expect(() => checkAndRecordUserCall("heavy-fg", { priority: "background" })).not.toThrow();
  });

  it("caps background calls at LLM_USER_BACKGROUND_DAILY_CAP without affecting foreground", () => {
    fillBucket("heavy-bg", "background", LLM_USER_BACKGROUND_DAILY_CAP);

    let caught: unknown;
    try {
      checkAndRecordUserCall("heavy-bg", { priority: "background" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UserRateLimitedError);
    const err = caught as UserRateLimitedError;
    expect(err.reason).toBe("daily");
    expect(err.priority).toBe("background");

    // Foreground bucket is still wide open — this is the whole point of the split
    expect(() => checkAndRecordUserCall("heavy-bg", { priority: "foreground" })).not.toThrow();
  });

  it("foreground and background buckets are independent in both directions", () => {
    fillBucket("split-user", "background", LLM_USER_BACKGROUND_DAILY_CAP);
    // Background is full; foreground should still drain fully
    fillBucket("split-user", "foreground", LLM_USER_FOREGROUND_DAILY_CAP);
    expect(() =>
      checkAndRecordUserCall("split-user", { priority: "foreground" }),
    ).toThrow(UserRateLimitedError);
    expect(() =>
      checkAndRecordUserCall("split-user", { priority: "background" }),
    ).toThrow(UserRateLimitedError);
  });

  it("defaults to the foreground bucket when no priority is provided", () => {
    fillBucket("default-pri", "foreground", LLM_USER_FOREGROUND_DAILY_CAP);
    let caught: unknown;
    try {
      checkAndRecordUserCall("default-pri");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UserRateLimitedError);
    expect((caught as UserRateLimitedError).priority).toBe("foreground");
  });

  it("getUserUsage reports per-bucket counts and the summed total", () => {
    checkAndRecordUserCall("u3", { priority: "foreground" });
    checkAndRecordUserCall("u3", { priority: "foreground" });
    checkAndRecordUserCall("u3", { priority: "background" });

    const snap = getUserUsage("u3");
    expect(snap.foregroundDailyUsed).toBe(2);
    expect(snap.backgroundDailyUsed).toBe(1);
    expect(snap.foregroundDailyCap).toBe(LLM_USER_FOREGROUND_DAILY_CAP);
    expect(snap.backgroundDailyCap).toBe(LLM_USER_BACKGROUND_DAILY_CAP);
    expect(snap.dailyUsed).toBe(3);
    expect(snap.dailyCap).toBe(LLM_USER_DAILY_CAP);
    expect(snap.rpmUsed).toBe(3);
    expect(snap.rpmCap).toBe(LLM_USER_RPM);
    expect(snap.dailyResetAt.getUTCHours()).toBe(0);
  });
});
