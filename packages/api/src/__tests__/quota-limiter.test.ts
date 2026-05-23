import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLM_USER_DAILY_CAP, LLM_USER_RPM } from "../config.js";
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

  it("enforces the daily cap independent of RPM", () => {
    // Spread calls across many minutes so RPM never trips
    for (let i = 0; i < LLM_USER_DAILY_CAP; i++) {
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
    expect((caught as UserRateLimitedError).reason).toBe("daily");
  });

  it("getUserUsage reports current rpm/daily counts", () => {
    checkAndRecordUserCall("u3");
    checkAndRecordUserCall("u3");
    const snap = getUserUsage("u3");
    expect(snap.rpmUsed).toBe(2);
    expect(snap.dailyUsed).toBe(2);
    expect(snap.rpmCap).toBe(LLM_USER_RPM);
    expect(snap.dailyCap).toBe(LLM_USER_DAILY_CAP);
    expect(snap.dailyResetAt.getUTCHours()).toBe(0);
  });
});
