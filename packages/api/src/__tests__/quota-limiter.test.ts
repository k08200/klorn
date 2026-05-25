import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LLM_USER_BACKGROUND_DAILY_CAP,
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

  it("enforces the foreground daily cap independent of RPM", () => {
    // Spread calls across many minutes so RPM never trips
    for (let i = 0; i < LLM_USER_FOREGROUND_DAILY_CAP; i++) {
      checkAndRecordUserCall("heavy");
      if (i % LLM_USER_RPM === LLM_USER_RPM - 1) vi.advanceTimersByTime(61_000);
    }
    let caught: unknown;
    try {
      checkAndRecordUserCall("heavy");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UserRateLimitedError);
    const err = caught as UserRateLimitedError;
    expect(err.reason).toBe("daily");
    expect(err.priority).toBe("foreground");
  });

  it("background quota exhaustion does NOT starve foreground chat", () => {
    // Background workers burn their entire daily allocation
    for (let i = 0; i < LLM_USER_BACKGROUND_DAILY_CAP; i++) {
      checkAndRecordUserCall("victim", { priority: "background" });
      if (i % LLM_USER_RPM === LLM_USER_RPM - 1) vi.advanceTimersByTime(61_000);
    }

    // Background is now exhausted
    expect(() => checkAndRecordUserCall("victim", { priority: "background" })).toThrow(
      UserRateLimitedError,
    );

    // Foreground (chat) should still work — that's the whole point of this PR
    vi.advanceTimersByTime(61_000); // make sure RPM is fresh
    expect(() => checkAndRecordUserCall("victim", { priority: "foreground" })).not.toThrow();
  });

  it("foreground quota exhaustion does NOT silently block background", () => {
    // Burn the foreground cap
    for (let i = 0; i < LLM_USER_FOREGROUND_DAILY_CAP; i++) {
      checkAndRecordUserCall("chatty", { priority: "foreground" });
      if (i % LLM_USER_RPM === LLM_USER_RPM - 1) vi.advanceTimersByTime(61_000);
    }
    expect(() => checkAndRecordUserCall("chatty", { priority: "foreground" })).toThrow(
      UserRateLimitedError,
    );

    // Background should still have its own reserve
    vi.advanceTimersByTime(61_000);
    expect(() => checkAndRecordUserCall("chatty", { priority: "background" })).not.toThrow();
  });

  it("daily-limit error reports the priority that tripped it", () => {
    for (let i = 0; i < LLM_USER_BACKGROUND_DAILY_CAP; i++) {
      checkAndRecordUserCall("bg-user", { priority: "background" });
      if (i % LLM_USER_RPM === LLM_USER_RPM - 1) vi.advanceTimersByTime(61_000);
    }
    let caught: unknown;
    try {
      checkAndRecordUserCall("bg-user", { priority: "background" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UserRateLimitedError);
    const err = caught as UserRateLimitedError;
    expect(err.priority).toBe("background");
    expect(err.message).toMatch(/background/i);
  });

  it("getUserUsage reports per-bucket counts and a combined total", () => {
    checkAndRecordUserCall("u3"); // default foreground
    checkAndRecordUserCall("u3", { priority: "foreground" });
    checkAndRecordUserCall("u3", { priority: "background" });
    const snap = getUserUsage("u3");

    expect(snap.rpmUsed).toBe(3);
    expect(snap.foregroundDailyUsed).toBe(2);
    expect(snap.backgroundDailyUsed).toBe(1);
    expect(snap.dailyUsed).toBe(3); // sum of both buckets

    expect(snap.rpmCap).toBe(LLM_USER_RPM);
    expect(snap.foregroundDailyCap).toBe(LLM_USER_FOREGROUND_DAILY_CAP);
    expect(snap.backgroundDailyCap).toBe(LLM_USER_BACKGROUND_DAILY_CAP);
    expect(snap.dailyCap).toBe(LLM_USER_FOREGROUND_DAILY_CAP + LLM_USER_BACKGROUND_DAILY_CAP);
    expect(snap.dailyResetAt.getUTCHours()).toBe(0);
  });
});
