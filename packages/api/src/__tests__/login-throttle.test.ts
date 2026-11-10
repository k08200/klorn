import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _loginThrottleTrackedCountForTests,
  _resetLoginThrottleForTests,
  clearLoginAttempts,
  isLoginThrottled,
  LOGIN_THROTTLE_MAX_FAILURES,
  LOGIN_THROTTLE_MAX_TRACKED,
  LOGIN_THROTTLE_WINDOW_MS,
  loginThrottleRemainingMs,
  recordLoginAttempt,
} from "../security/login-throttle.js";

describe("login throttle — per-account fixed window", () => {
  beforeEach(() => {
    _resetLoginThrottleForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is not throttled below the failure threshold", () => {
    for (let i = 0; i < LOGIN_THROTTLE_MAX_FAILURES - 1; i++) {
      recordLoginAttempt("a@example.com");
    }
    expect(isLoginThrottled("a@example.com")).toBe(false);
  });

  it("throttles once the threshold is reached", () => {
    for (let i = 0; i < LOGIN_THROTTLE_MAX_FAILURES; i++) {
      recordLoginAttempt("a@example.com");
    }
    expect(isLoginThrottled("a@example.com")).toBe(true);
  });

  it("tracks accounts independently", () => {
    for (let i = 0; i < LOGIN_THROTTLE_MAX_FAILURES; i++) {
      recordLoginAttempt("a@example.com");
    }
    expect(isLoginThrottled("b@example.com")).toBe(false);
  });

  it("unlocks after the window expires", () => {
    for (let i = 0; i < LOGIN_THROTTLE_MAX_FAILURES; i++) {
      recordLoginAttempt("a@example.com");
    }
    expect(isLoginThrottled("a@example.com")).toBe(true);
    vi.advanceTimersByTime(LOGIN_THROTTLE_WINDOW_MS);
    expect(isLoginThrottled("a@example.com")).toBe(false);
  });

  it("a successful login clears accumulated failures", () => {
    for (let i = 0; i < LOGIN_THROTTLE_MAX_FAILURES - 1; i++) {
      recordLoginAttempt("a@example.com");
    }
    clearLoginAttempts("a@example.com");
    recordLoginAttempt("a@example.com");
    expect(isLoginThrottled("a@example.com")).toBe(false);
  });

  it("failures within a window accumulate from the first failure, not the last", () => {
    recordLoginAttempt("a@example.com");
    vi.advanceTimersByTime(LOGIN_THROTTLE_WINDOW_MS - 1000);
    for (let i = 0; i < LOGIN_THROTTLE_MAX_FAILURES - 1; i++) {
      recordLoginAttempt("a@example.com");
    }
    expect(isLoginThrottled("a@example.com")).toBe(true);
    // 1s later the window that started at the FIRST failure has expired.
    vi.advanceTimersByTime(1000);
    expect(isLoginThrottled("a@example.com")).toBe(false);
  });

  it("reports the true remaining lock time, which decays with elapsed time", () => {
    for (let i = 0; i < LOGIN_THROTTLE_MAX_FAILURES; i++) {
      recordLoginAttempt("a@example.com");
    }
    expect(loginThrottleRemainingMs("a@example.com")).toBe(LOGIN_THROTTLE_WINDOW_MS);
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(loginThrottleRemainingMs("a@example.com")).toBe(
      LOGIN_THROTTLE_WINDOW_MS - 5 * 60 * 1000,
    );
    expect(loginThrottleRemainingMs("b@example.com")).toBe(0);
  });

  it("the threshold exceeds the per-IP login limit so one IP alone cannot trip it", () => {
    // POST /login is capped at 10/15min per IP (routes/auth.ts). If this
    // invariant breaks, a single source address can lock out any account.
    expect(LOGIN_THROTTLE_MAX_FAILURES).toBeGreaterThan(10);
  });

  it("enforces a hard cap on tracked accounts by evicting oldest windows", () => {
    for (let i = 0; i < LOGIN_THROTTLE_MAX_TRACKED; i++) {
      recordLoginAttempt(`probe-${i}@example.com`);
    }
    expect(_loginThrottleTrackedCountForTests()).toBe(LOGIN_THROTTLE_MAX_TRACKED);

    // All windows are still fresh — the sweep finds nothing, so the cap must
    // hold via oldest-first eviction, and the newest entry must be tracked.
    recordLoginAttempt("newest@example.com");
    expect(_loginThrottleTrackedCountForTests()).toBeLessThanOrEqual(LOGIN_THROTTLE_MAX_TRACKED);
    expect(_loginThrottleTrackedCountForTests()).toBeGreaterThan(0);
    recordLoginAttempt("newest@example.com");
    expect(isLoginThrottled("probe-0@example.com")).toBe(false); // evicted, fails open
  });
});
