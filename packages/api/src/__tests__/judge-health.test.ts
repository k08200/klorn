import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetJudgeHealth,
  checkJudgeHeartbeat,
  recordJudgeSource,
  runJudgeHeartbeatCheck,
} from "../judge/judge-health.js";

afterEach(() => {
  __resetJudgeHealth();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("judge health — recordJudgeSource is the heartbeat feed only (#1319)", () => {
  it("never alarms on its own, however many fallbacks it sees — the DB-backed check does", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 500; i++) recordJudgeSource("keyword-fallback");
    expect(errSpy).not.toHaveBeenCalled();
    expect(checkJudgeHeartbeat().alive).toBe(true);
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
