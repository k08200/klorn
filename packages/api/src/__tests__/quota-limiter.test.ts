import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetAllUserWindowsForTests,
  awaitUserCallSlot,
  checkAndRecordUserCall,
  getUserUsage,
  rpmCeilingFor,
  UserRateLimitedError,
} from "../billing/quota-limiter.js";
import {
  LLM_RPM_FOREGROUND_RESERVE,
  LLM_USER_BACKGROUND_DAILY_CAP,
  LLM_USER_FOREGROUND_DAILY_CAP,
  LLM_USER_RPM,
} from "../config.js";

const BG_RPM_CEILING = Math.max(1, LLM_USER_RPM - LLM_RPM_FOREGROUND_RESERVE);

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
      if (i % BG_RPM_CEILING === BG_RPM_CEILING - 1) vi.advanceTimersByTime(61_000);
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
      if (i % BG_RPM_CEILING === BG_RPM_CEILING - 1) vi.advanceTimersByTime(61_000);
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

  it("reserves the last RPM slots for foreground: background trips early, chat still fits", () => {
    // Background may only consume RPM - reserve slots of the shared window…
    for (let i = 0; i < BG_RPM_CEILING; i++) {
      checkAndRecordUserCall("u1", { priority: "background" });
    }
    expect(() => checkAndRecordUserCall("u1", { priority: "background" })).toThrow(
      UserRateLimitedError,
    );
    // …so foreground chat still has headroom during a background burst.
    for (let i = 0; i < LLM_RPM_FOREGROUND_RESERVE; i++) {
      expect(() => checkAndRecordUserCall("u1", { priority: "foreground" })).not.toThrow();
    }
    expect(() => checkAndRecordUserCall("u1", { priority: "foreground" })).toThrow(
      UserRateLimitedError,
    );
  });

  it("rpmCeilingFor exposes the per-priority admission limits", () => {
    expect(rpmCeilingFor("foreground")).toBe(LLM_USER_RPM);
    expect(rpmCeilingFor("background")).toBe(BG_RPM_CEILING);
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

  describe("awaitUserCallSlot", () => {
    function fillRpmWindow(userId: string): void {
      for (let i = 0; i < LLM_USER_RPM; i++) {
        checkAndRecordUserCall(userId, { priority: "foreground" });
      }
    }

    it("background call waits for the sliding window instead of failing", async () => {
      fillRpmWindow("u1");
      let resolved = false;
      const slot = awaitUserCallSlot("u1", { priority: "background" }).then(() => {
        resolved = true;
      });
      // Still parked while the window is full…
      await vi.advanceTimersByTimeAsync(5_000);
      expect(resolved).toBe(false);
      // …admitted once the 60 s window slides past the burst.
      await vi.advanceTimersByTimeAsync(60_000);
      await slot;
      expect(resolved).toBe(true);
      expect(getUserUsage("u1").backgroundDailyUsed).toBe(1);
    });

    it("a queued burst drains across window turns in order of arrival", async () => {
      fillRpmWindow("u1");
      const waiters = BG_RPM_CEILING + 2;
      let done = 0;
      const slots = Array.from({ length: waiters }, () =>
        awaitUserCallSlot("u1", { priority: "background", maxWaitMs: 10 * 60_000 }).then(() => {
          done++;
        }),
      );
      // First window turn admits up to the background ceiling…
      await vi.advanceTimersByTimeAsync(62_000);
      expect(done).toBe(BG_RPM_CEILING);
      // …the rest drain on the next turn instead of falling back.
      await vi.advanceTimersByTimeAsync(62_000);
      await Promise.all(slots);
      expect(done).toBe(waiters);
    });

    it("fails fast when the next slot is beyond maxWaitMs", async () => {
      fillRpmWindow("u1");
      await expect(
        awaitUserCallSlot("u1", { priority: "background", maxWaitMs: 10 }),
      ).rejects.toBeInstanceOf(UserRateLimitedError);
    });

    it("maxWaitMs: 0 disables waiting entirely (pre-queue fail-fast behavior)", async () => {
      fillRpmWindow("u1");
      await expect(
        awaitUserCallSlot("u1", { priority: "background", maxWaitMs: 0 }),
      ).rejects.toBeInstanceOf(UserRateLimitedError);
    });

    it("daily-cap exhaustion rejects immediately — waiting cannot help until UTC midnight", async () => {
      for (let i = 0; i < LLM_USER_BACKGROUND_DAILY_CAP; i++) {
        checkAndRecordUserCall("u1", { priority: "background" });
        if (i % BG_RPM_CEILING === BG_RPM_CEILING - 1) vi.advanceTimersByTime(61_000);
      }
      vi.advanceTimersByTime(61_000); // RPM window is fresh; only the daily cap blocks
      let caught: unknown;
      try {
        await awaitUserCallSlot("u1", { priority: "background", maxWaitMs: 60_000 });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(UserRateLimitedError);
      expect((caught as UserRateLimitedError).reason).toBe("daily");
    });

    it("foreground calls never queue — chat fails fast for responsive UX", async () => {
      fillRpmWindow("u1");
      await expect(
        awaitUserCallSlot("u1", { priority: "foreground", maxWaitMs: 60_000 }),
      ).rejects.toBeInstanceOf(UserRateLimitedError);
    });
  });
});
