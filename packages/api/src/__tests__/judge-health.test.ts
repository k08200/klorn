import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capturedErrors = vi.hoisted(() => [] as Array<{ err: unknown; ctx: unknown }>);
vi.mock("../sentry.js", () => ({
  captureError: vi.fn((err: unknown, ctx: unknown) => {
    capturedErrors.push({ err, ctx });
  }),
}));

const opsNotifications = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const opsBehavior = vi.hoisted(() => ({ reject: false }));
vi.mock("../ops/admin-ops-notification.js", () => ({
  createAdminOpsNotifications: vi.fn(async (input: Record<string, unknown>) => {
    if (opsBehavior.reject) throw new Error("db down");
    opsNotifications.push(input);
    return 1;
  }),
}));

import {
  __resetJudgeHealth,
  checkJudgeHeartbeat,
  getJudgeHealth,
  getPublicJudgeHealth,
  JUDGE_HEALTH_ALARM_INTERVAL_MS,
  JUDGE_HEALTH_FALLBACK_ALARM_RATIO,
  JUDGE_HEALTH_MAX_EVENTS,
  JUDGE_HEALTH_MIN_LLM_ELIGIBLE,
  JUDGE_HEALTH_WINDOW_MS,
  type JudgeSource,
  recordJudgeSource,
  runJudgeHeartbeatCheck,
} from "../judge/judge-health.js";
import { __resetLlmFailureLog, recordLlmCallFailure } from "../llm/llm-failure-log.js";

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

function recordMany(source: JudgeSource, n: number, at: number): void {
  for (let i = 0; i < n; i++) recordJudgeSource(source, at);
}

function judgeAlarms(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((c) => String(c[0]))
    .filter((line) => line.includes("[JUDGE-HEALTH] LLM judge failing"));
}

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetJudgeHealth();
  __resetLlmFailureLog();
  capturedErrors.length = 0;
  opsNotifications.length = 0;
  opsBehavior.reject = false;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  __resetJudgeHealth();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("judge health — named alarm constants", () => {
  it("pins the window, sample floor, threshold and interval", () => {
    expect(JUDGE_HEALTH_WINDOW_MS).toBe(60 * MINUTE);
    expect(JUDGE_HEALTH_MIN_LLM_ELIGIBLE).toBe(20);
    expect(JUDGE_HEALTH_FALLBACK_ALARM_RATIO).toBe(0.5);
    expect(JUDGE_HEALTH_ALARM_INTERVAL_MS).toBe(60 * MINUTE);
  });
});

describe("judge health — fallback ratio over LLM-eligible judgments", () => {
  it("reports 0 fallback and not degraded on a healthy LLM stream", () => {
    recordMany("llm", 50, T0);
    expect(getJudgeHealth(T0)).toMatchObject({
      total: 50,
      fallbacks: 0,
      fallbackRate: 0,
      degraded: false,
    });
  });

  it("excludes deterministic short-circuits (fast-path, sender-prior, pinned, learned) from the ratio", () => {
    // Total LLM outage while most mail is newsletters: every LLM-eligible email
    // fell back. Counting the fast-path would dilute this to ~16% and stay quiet.
    recordMany("keyword-fallback", 20, T0);
    recordMany("fast-path", 60, T0);
    recordMany("sender-prior", 30, T0);
    recordMany("pinned-rule", 10, T0);
    recordMany("learned-rule", 5, T0);
    const h = getJudgeHealth(T0);
    expect(h.total).toBe(20);
    expect(h.fallbackRate).toBe(1);
    expect(h.degraded).toBe(true);
  });

  it("stays quiet below the minimum LLM-eligible sample even at 100% fallback", () => {
    recordMany("keyword-fallback", JUDGE_HEALTH_MIN_LLM_ELIGIBLE - 1, T0);
    recordMany("fast-path", 100, T0);
    expect(getJudgeHealth(T0).degraded).toBe(false);
    expect(judgeAlarms(errSpy)).toHaveLength(0);
    expect(capturedErrors).toHaveLength(0);
  });

  it("does not alarm when the fallback share is under the threshold", () => {
    // 8/20 = 40% fallback: above any "some fallback" floor, below the 50% bar.
    recordMany("llm", 12, T0);
    recordMany("keyword-fallback", 8, T0);
    const h = getJudgeHealth(T0);
    expect(h.fallbackRate).toBeCloseTo(0.4, 5);
    expect(h.degraded).toBe(false);
    expect(judgeAlarms(errSpy)).toHaveLength(0);
    expect(opsNotifications).toHaveLength(0);
  });

  it("flags degraded once the fallback share exceeds the threshold", () => {
    recordMany("llm", 8, T0);
    recordMany("keyword-fallback", 12, T0);
    const h = getJudgeHealth(T0);
    expect(h.fallbackRate).toBeCloseTo(0.6, 5);
    expect(h.degraded).toBe(true);
  });

  it("forgets judgments older than the window, so the stream recovers on its own", () => {
    recordMany("keyword-fallback", 30, T0);
    expect(getJudgeHealth(T0).degraded).toBe(true);
    const later = T0 + JUDGE_HEALTH_WINDOW_MS + 1;
    recordMany("llm", 25, later);
    expect(getJudgeHealth(later)).toMatchObject({ total: 25, fallbacks: 0, degraded: false });
  });

  it("bounds memory under a flood of judgments", () => {
    recordMany("llm", JUDGE_HEALTH_MAX_EVENTS + 500, T0);
    expect(getJudgeHealth(T0).total).toBe(JUDGE_HEALTH_MAX_EVENTS);
  });
});

describe("judge health — alarm (Sentry + ops Notification, once per interval)", () => {
  it("fires Sentry, console.error and one ops Notification naming the top provider error", () => {
    for (let i = 0; i < 5; i++) {
      recordLlmCallFailure(
        { provider: "openrouter", model: "google/gemma-4-31b-it" },
        Object.assign(new Error("402 Insufficient credits"), { status: 402 }),
        T0,
      );
    }
    recordMany("keyword-fallback", 20, T0);

    const alarms = judgeAlarms(errSpy);
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toContain("LLM judge failing: 100% fallback in last 60 min");
    expect(alarms[0]).toContain("top error: 402 credits exhausted (openrouter)");

    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0].ctx).toMatchObject({
      tags: { scope: "judge-health" },
      extra: { fallbackRate: 1, sample: 20, topError: "402 credits exhausted (openrouter)" },
    });

    expect(opsNotifications).toHaveLength(1);
    expect(opsNotifications[0].title).toBe("LLM judge failing");
    expect(String(opsNotifications[0].message)).toContain("top error: 402 credits exhausted");
    expect(String(opsNotifications[0].dedupeKey)).toMatch(/^judge-fallback:/);
  });

  it("says so when no provider error was recorded (gate or parse failures)", () => {
    recordMany("keyword-fallback", 20, T0);
    expect(judgeAlarms(errSpy)[0]).toContain("top error: none recorded at provider dispatch");
  });

  it("alarms at most once per interval while degradation persists, then again after it", () => {
    recordMany("keyword-fallback", 20, T0);
    // Sustained outage: keep judging (and failing) for the rest of the interval.
    for (let m = 1; m < 60; m += 5) recordMany("keyword-fallback", 5, T0 + m * MINUTE);
    expect(judgeAlarms(errSpy)).toHaveLength(1);
    expect(capturedErrors).toHaveLength(1);
    expect(opsNotifications).toHaveLength(1);

    recordMany("keyword-fallback", 5, T0 + JUDGE_HEALTH_ALARM_INTERVAL_MS);
    expect(judgeAlarms(errSpy)).toHaveLength(2);
    expect(capturedErrors).toHaveLength(2);
    expect(opsNotifications).toHaveLength(2);
    expect(opsNotifications[0].dedupeKey).not.toBe(opsNotifications[1].dedupeKey);
  });

  it("does not re-alarm inside the interval when degradation flaps off and on", () => {
    recordMany("keyword-fallback", 20, T0);
    recordMany("llm", 30, T0 + MINUTE); // 20/50 = 40% → recovered
    expect(getJudgeHealth(T0 + MINUTE).degraded).toBe(false);
    recordMany("keyword-fallback", 40, T0 + 2 * MINUTE); // 60/90 → degraded again
    expect(getJudgeHealth(T0 + 2 * MINUTE).degraded).toBe(true);
    expect(judgeAlarms(errSpy)).toHaveLength(1);
    expect(opsNotifications).toHaveLength(1);
  });

  it("never throws into the judge path when the ops Notification write fails", async () => {
    opsBehavior.reject = true;
    expect(() => recordMany("keyword-fallback", 20, T0)).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(capturedErrors).toHaveLength(1);
  });
});

describe("judge health — public surface", () => {
  it("exposes only a coarse status and an aggregate ratio, never error text", () => {
    recordLlmCallFailure(
      { provider: "openrouter", model: "m" },
      Object.assign(new Error("402 Insufficient credits"), { status: 402 }),
      T0,
    );
    recordMany("keyword-fallback", 20, T0);
    const pub = getPublicJudgeHealth(T0);
    expect(pub).toEqual({ status: "degraded", fallbackRatio: 1 });
    expect(JSON.stringify(pub)).not.toMatch(/credit|402|openrouter/);
  });

  it("reports ok with the rounded ratio on a healthy stream", () => {
    recordMany("llm", 2, T0);
    recordMany("keyword-fallback", 1, T0);
    expect(getPublicJudgeHealth(T0)).toEqual({ status: "ok", fallbackRatio: 0.33 });
  });

  it("names the top error on the admin (authenticated) surface", () => {
    recordLlmCallFailure(
      { provider: "openrouter", model: "m" },
      Object.assign(new Error("402"), { status: 402 }),
      T0,
    );
    recordMany("keyword-fallback", 20, T0);
    expect(getJudgeHealth(T0).topError).toBe("402 credits exhausted (openrouter)");
  });
});

describe("judge health — heartbeat (#742, canary of the canary)", () => {
  const START = 1_700_000_000_000; // arbitrary fixed epoch ms

  it("is not alive in the explicit test-reset (null) state", () => {
    // __resetJudgeHealth (test-only) simulates this edge case deliberately —
    // real process boot never reaches it, see the next test.
    const beat = checkJudgeHeartbeat(START);
    expect(beat).toEqual({ alive: false, lastRecordedAt: null, silentForMs: null });
  });

  it("is alive on fresh module load (process boot) with zero recordJudgeSource calls — regression for the every-deploy false alarm", async () => {
    // The daily scheduler tick runs once immediately on process start
    // (automation-scheduler.ts), seconds after boot — long before any email
    // could plausibly have been classified. lastRecordedAt must be seeded at
    // module load (not null) or runJudgeHeartbeatCheck alarms on every deploy.
    vi.resetModules();
    const fresh = await import("../judge/judge-health.js");
    const beat = fresh.checkJudgeHeartbeat(Date.now() + 1000);
    expect(beat.alive).toBe(true);
    fresh.__resetJudgeHealth();
  });

  it("is alive immediately after a judge decision is recorded", () => {
    vi.spyOn(Date, "now").mockReturnValue(START);
    recordJudgeSource("llm");
    const beat = checkJudgeHeartbeat(START);
    expect(beat.alive).toBe(true);
    expect(beat.lastRecordedAt).toBe(START);
    expect(beat.silentForMs).toBe(0);
  });

  it("goes dead once silence exceeds the max-silence window — a dead feed, not a quiet one", () => {
    vi.spyOn(Date, "now").mockReturnValue(START);
    recordJudgeSource("llm");
    const THIRTY_HOURS_LATER = START + 30 * 60 * 60 * 1000;
    const beat = checkJudgeHeartbeat(THIRTY_HOURS_LATER);
    expect(beat.alive).toBe(false);
    expect(beat.silentForMs).toBe(30 * 60 * 60 * 1000);
  });

  it("stays alive within a configured shorter max-silence window", () => {
    vi.stubEnv("JUDGE_HEALTH_HEARTBEAT_MAX_SILENCE_MS", String(2 * 60 * 60 * 1000));
    vi.spyOn(Date, "now").mockReturnValue(START);
    recordJudgeSource("llm");
    const ONE_HOUR_LATER = START + 60 * 60 * 1000;
    expect(checkJudgeHeartbeat(ONE_HOUR_LATER).alive).toBe(true);
    const THREE_HOURS_LATER = START + 3 * 60 * 60 * 1000;
    expect(checkJudgeHeartbeat(THREE_HOURS_LATER).alive).toBe(false);
  });

  it("alarms exactly once when the feed is dead", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    runJudgeHeartbeatCheck(START); // never recorded — dead from process start
    const alarms = errSpy.mock.calls.filter((c) => String(c[0]).includes("[JUDGE-HEALTH]"));
    expect(alarms.length).toBe(1);
    expect(String(alarms[0][0])).toContain("Heartbeat dead");
  });

  it("does not alarm while the feed is alive", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(START);
    recordJudgeSource("llm");
    runJudgeHeartbeatCheck(START);
    expect(errSpy).not.toHaveBeenCalled();
  });
});
