import { beforeEach, describe, expect, it } from "vitest";
import {
  buildSchedulerHealthReport,
  EXPECTED_SCHEDULERS,
  getSchedulerHealth,
  markSchedulerDisabled,
  recordSchedulerTick,
  registerScheduler,
  resetSchedulerHeartbeats,
} from "../scheduler-heartbeat.js";

const T0 = 1_700_000_000_000;

function registerAll(now = T0) {
  for (const name of EXPECTED_SCHEDULERS) {
    registerScheduler(name, 60_000, now);
  }
}

describe("scheduler-heartbeat", () => {
  beforeEach(() => {
    resetSchedulerHeartbeats();
  });

  it("treats registration as the first heartbeat so a delayed first tick is not stale", () => {
    // naver-imap/github fire their first tick 30s after start; registration
    // must count as "alive" or every boot would begin in a stale state.
    registerScheduler("naver-imap", 5 * 60_000, T0);
    const health = getSchedulerHealth({ now: T0 + 30_000, uptimeMs: 30_000 });
    const entry = health.schedulers.find((s) => s.name === "naver-imap");
    expect(entry?.stale).toBe(false);
    expect(entry?.lastSeenAt).toBe(T0);
  });

  it("marks a scheduler stale after 3x its interval with no tick", () => {
    registerScheduler("automation", 60_000, T0);
    const justUnder = getSchedulerHealth({ now: T0 + 3 * 60_000, uptimeMs: 10 * 60_000 });
    expect(justUnder.schedulers[0]?.stale).toBe(false);
    const over = getSchedulerHealth({ now: T0 + 3 * 60_000 + 1, uptimeMs: 10 * 60_000 });
    expect(over.schedulers[0]?.stale).toBe(true);
  });

  it("applies a 120s floor so short-interval schedulers do not false-alarm", () => {
    // reminder ticks every 30s; 3x = 90s would flag a single slow deploy or
    // event-loop pause. The floor keeps the threshold at 120s minimum.
    registerScheduler("reminder", 30_000, T0);
    const at100s = getSchedulerHealth({ now: T0 + 100_000, uptimeMs: 10 * 60_000 });
    expect(at100s.schedulers[0]?.stale).toBe(false);
    const at121s = getSchedulerHealth({ now: T0 + 121_000, uptimeMs: 10 * 60_000 });
    expect(at121s.schedulers[0]?.stale).toBe(true);
  });

  it("a tick refreshes the heartbeat and clears staleness", () => {
    registerScheduler("automation", 60_000, T0);
    recordSchedulerTick("automation", T0 + 5 * 60_000);
    const health = getSchedulerHealth({ now: T0 + 5 * 60_000 + 1_000, uptimeMs: 10 * 60_000 });
    expect(health.schedulers[0]?.stale).toBe(false);
    expect(health.schedulers[0]?.lastSeenAt).toBe(T0 + 5 * 60_000);
  });

  it("ignores ticks for schedulers that were never registered", () => {
    recordSchedulerTick("reminder", T0);
    const health = getSchedulerHealth({ now: T0, uptimeMs: 10 * 60_000 });
    expect(health.schedulers).toHaveLength(0);
  });

  it("reports expected schedulers that never registered as missing", () => {
    // pattern-learner's dynamic import failure is silently swallowed at
    // startup; the only external signal is its absence from the registry.
    registerAll();
    resetSchedulerHeartbeats();
    registerScheduler(EXPECTED_SCHEDULERS[0], 60_000, T0);
    const health = getSchedulerHealth({ now: T0, uptimeMs: 10 * 60_000 });
    expect(health.missing).toEqual(EXPECTED_SCHEDULERS.slice(1));
    expect(health.ok).toBe(false);
  });

  it("does not fail on missing schedulers during the startup grace window", () => {
    const health = getSchedulerHealth({ now: T0, uptimeMs: 30_000 });
    expect(health.missing.length).toBeGreaterThan(0);
    expect(health.ok).toBe(true);
  });

  it("is healthy when every expected scheduler is registered and fresh", () => {
    registerAll();
    const health = getSchedulerHealth({ now: T0 + 60_000, uptimeMs: 10 * 60_000 });
    expect(health.missing).toEqual([]);
    expect(health.ok).toBe(true);
  });

  it("a deliberately disabled scheduler is never stale and never missing", () => {
    // autonomous-agent refuses to start when no LLM is configured (self-host);
    // that must read as "off by design", not as a dead loop.
    registerAll();
    resetSchedulerHeartbeats();
    for (const name of EXPECTED_SCHEDULERS) {
      if (name === "autonomous-agent") markSchedulerDisabled(name, T0);
      else registerScheduler(name, 60_000, T0);
    }
    const health = getSchedulerHealth({ now: T0 + 24 * 60 * 60_000, uptimeMs: 10 * 60_000 });
    const entry = health.schedulers.find((s) => s.name === "autonomous-agent");
    expect(entry?.disabled).toBe(true);
    expect(entry?.stale).toBe(false);
    expect(health.missing).toEqual([]);
  });
});

describe("buildSchedulerHealthReport", () => {
  beforeEach(() => {
    resetSchedulerHeartbeats();
  });

  it("returns 200 with status=disabled when background agents are off", () => {
    const report = buildSchedulerHealthReport({ disabled: true, now: T0, uptimeMs: 0 });
    expect(report.statusCode).toBe(200);
    expect(report.body.status).toBe("disabled");
  });

  it("returns 503 when a scheduler is stale so an external monitor can alert", () => {
    registerAll();
    const report = buildSchedulerHealthReport({
      disabled: false,
      now: T0 + 4 * 60_000,
      uptimeMs: 10 * 60_000,
    });
    expect(report.statusCode).toBe(503);
    expect(report.body.status).toBe("stale");
  });

  it("returns 200 with status=ok when all schedulers are fresh", () => {
    registerAll();
    const report = buildSchedulerHealthReport({
      disabled: false,
      now: T0 + 60_000,
      uptimeMs: 10 * 60_000,
    });
    expect(report.statusCode).toBe(200);
    expect(report.body.status).toBe("ok");
    expect(report.body.schedulers).toHaveLength(EXPECTED_SCHEDULERS.length);
  });
});
