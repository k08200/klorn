import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetJudgeHealth,
  checkJudgeHeartbeat,
  getJudgeHealth,
  recordJudgeSource,
  runJudgeHeartbeatCheck,
} from "../judge/judge-health.js";

afterEach(() => {
  __resetJudgeHealth();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("judge health — fallback-rate tripwire", () => {
  it("reports 0 fallback rate and not-degraded on a healthy LLM stream", () => {
    for (let i = 0; i < 50; i++) recordJudgeSource("llm");
    const h = getJudgeHealth();
    expect(h.total).toBe(50);
    expect(h.fallbackRate).toBe(0);
    expect(h.degraded).toBe(false);
  });

  it("stays quiet below the minimum sample even if every call fell back", () => {
    vi.stubEnv("JUDGE_HEALTH_MIN_SAMPLE", "30");
    for (let i = 0; i < 10; i++) recordJudgeSource("keyword-fallback");
    // 100% fallback but only 10 samples — not enough signal to alarm.
    expect(getJudgeHealth().degraded).toBe(false);
  });

  it("flags degraded once the keyword-fallback rate exceeds the alarm threshold", () => {
    vi.stubEnv("JUDGE_HEALTH_MIN_SAMPLE", "20");
    vi.stubEnv("JUDGE_HEALTH_FALLBACK_RATE", "0.2");
    // 30 llm + 20 fallback = 40% fallback over 50 samples → degraded.
    for (let i = 0; i < 30; i++) recordJudgeSource("llm");
    for (let i = 0; i < 20; i++) recordJudgeSource("keyword-fallback");
    const h = getJudgeHealth();
    expect(h.fallbackRate).toBeCloseTo(0.4, 5);
    expect(h.degraded).toBe(true);
  });

  it("fires the alarm exactly once on threshold crossing, not on every call", () => {
    vi.stubEnv("JUDGE_HEALTH_MIN_SAMPLE", "20");
    vi.stubEnv("JUDGE_HEALTH_FALLBACK_RATE", "0.2");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 20; i++) recordJudgeSource("keyword-fallback");
    // Still degraded on subsequent records, but the alarm must not re-spam.
    for (let i = 0; i < 10; i++) recordJudgeSource("keyword-fallback");
    const alarms = errSpy.mock.calls.filter((c) => String(c[0]).includes("[JUDGE-HEALTH]"));
    expect(alarms.length).toBe(1);
  });

  it("bounds memory: only the most recent window is retained", () => {
    vi.stubEnv("JUDGE_HEALTH_WINDOW", "100");
    for (let i = 0; i < 500; i++) recordJudgeSource("llm");
    expect(getJudgeHealth().total).toBe(100);
  });

  it("recovers (clears degraded + re-arms the alarm) once the stream is healthy again", () => {
    vi.stubEnv("JUDGE_HEALTH_WINDOW", "50");
    vi.stubEnv("JUDGE_HEALTH_MIN_SAMPLE", "20");
    vi.stubEnv("JUDGE_HEALTH_FALLBACK_RATE", "0.2");
    for (let i = 0; i < 50; i++) recordJudgeSource("keyword-fallback");
    expect(getJudgeHealth().degraded).toBe(true);
    for (let i = 0; i < 50; i++) recordJudgeSource("llm"); // window rolls over
    expect(getJudgeHealth().degraded).toBe(false);
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
