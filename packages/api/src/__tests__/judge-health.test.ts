import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetJudgeHealth, getJudgeHealth, recordJudgeSource } from "../judge-health.js";

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
