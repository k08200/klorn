import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Both cross-instance schedulers take their tick through the scheduler lease,
// each under its own name, and a refused lease means the tick does no work at
// all (the lease itself logs the skip, see scheduler-lease.test.ts).

const m = vi.hoisted(() => {
  const detachedJobs: string[] = [];
  return {
    granted: false,
    rejectWork: false,
    leases: [] as string[],
    attempts: [] as string[],
    dbCalls: [] as string[],
    /** Every granted tick's own promise, so a test can wait it out. */
    ticks: [] as Promise<void>[],
    /** The fire-and-forget jobs a granted tick started, once each has run. */
    detachedJobs,
    /** Stands in for a detached job: records that it ran and settles at once. */
    job: (name: string) => async () => {
      detachedJobs.push(name);
    },
    drainActionOutbox: vi.fn(async () => ({ completed: 0, retried: 0, dead: 0, reclaimed: 0 })),
  };
});

vi.mock("../scheduler-lease.js", () => ({
  createSchedulerLease: ({ name }: { name: string }) => {
    m.leases.push(name);
    return {
      runExclusive: async (work: () => Promise<void>) => {
        m.attempts.push(name);
        if (m.rejectWork) throw new Error("escaped the tick");
        if (!m.granted) return false;
        const tick = work();
        m.ticks.push(tick);
        await tick;
        return true;
      },
    };
  },
}));
vi.mock("../agentcore/action-outbox.js", () => ({ drainActionOutbox: m.drainActionOutbox }));
// The jobs a first automation tick starts without awaiting, each behind a
// dynamic import (on a Wednesday, flags off; the hourly checks wait out a boot
// delay). The real ones load and run after the test has returned, and on CI
// (2026-11-13) one logged after the file's environment was torn down, which
// fails the run. These settle as soon as they are called, so the test can
// wait for every one. A new detached job in runAutomationTick belongs here and
// in DETACHED_AUTOMATION_JOBS below.
vi.mock("../pim/daily-digest.js", () => ({ sendDailyDigests: m.job("daily-digest") }));
vi.mock("../judge/calibration-snapshot.js", () => ({
  runDailyCalibrationSnapshots: m.job("calibration-snapshot"),
}));
vi.mock("../learning/ontology-proposals-store.js", () => ({
  recomputeOntologyProposalsSafe: m.job("ontology-proposals"),
}));
// Also imported statically (email-firewall), so only the heartbeat is swapped.
vi.mock("../judge/judge-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../judge/judge-health.js")>()),
  runJudgeHeartbeatCheck: m.job("judge-heartbeat"),
}));
vi.mock("../providers/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../providers/index.js")>()),
  hasLlmProvider: () => true,
}));
/** Records every table call; a refused tick must make none. */
vi.mock("../db.js", () => {
  const table = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, method: string) => () => {
          m.dbCalls.push(`${name}.${method}`);
          return Promise.resolve(method === "findMany" ? [] : { count: 0 });
        },
      },
    );
  const prisma = new Proxy({}, { get: (_target, name: string) => table(name) });
  return { prisma, db: prisma };
});

/**
 * Midweek in every time zone (the tick reads local getDay()), so the Sunday
 * and Monday jobs stay out of it.
 */
const FIXED_NOW = new Date("2026-11-11T12:00:00Z");
const DETACHED_AUTOMATION_JOBS = [
  "calibration-snapshot",
  "daily-digest",
  "judge-heartbeat",
  "ontology-proposals",
];

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await vi.advanceTimersByTimeAsync(10);
  expect(condition()).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  vi.resetModules();
  m.granted = false;
  m.rejectWork = false;
  m.leases.length = 0;
  m.attempts.length = 0;
  m.dbCalls.length = 0;
  m.ticks.length = 0;
  m.detachedJobs.length = 0;
  m.drainActionOutbox.mockClear();
  // A granted tick runs against the empty db mock above, and some of its jobs
  // say so; only the refused ticks' silence is asserted.
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// A granted case waits out its tick (and the automation tick's detached jobs)
// before it returns, so no work from one test runs into the next or past the
// file's teardown.
describe("schedulers take each tick through the scheduler lease", () => {
  it("automation: a refused lease runs nothing", async () => {
    const scheduler = await import("../automation-scheduler.js");
    expect(m.leases).toEqual(["automation"]);

    scheduler.startAutomationScheduler();
    await until(() => m.attempts.includes("automation"));
    scheduler.stopAutomationScheduler();

    expect(m.drainActionOutbox).not.toHaveBeenCalled();
    expect(m.dbCalls).toEqual([]);
  });

  it("automation: every tick asks again after a refusal or an escaped error", async () => {
    // The in-process latch is cleared whatever the tick did, so a refused or
    // failed tick never stops the next one (the stall the latch could cause).
    const scheduler = await import("../automation-scheduler.js");
    scheduler.startAutomationScheduler();
    await until(() => m.attempts.length === 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.attempts).toHaveLength(2);

    m.rejectWork = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.attempts).toHaveLength(3);
    m.rejectWork = false;
    await vi.advanceTimersByTimeAsync(60_000);
    scheduler.stopAutomationScheduler();

    expect(m.attempts).toHaveLength(4);
    expect(m.dbCalls).toEqual([]);
  });

  it("autonomous agent: its own lease, and a refused one runs nothing", async () => {
    const scheduler = await import("../agentcore/autonomous-agent-scheduler.js");
    expect(m.leases).toEqual(["autonomous-agent"]);

    scheduler.startAutonomousAgent();
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => m.attempts.includes("autonomous-agent"));
    scheduler.stopAutonomousAgent();

    expect(m.dbCalls).toEqual([]);
  });

  it("autonomous agent: every tick asks again after a refusal or an escaped error", async () => {
    const scheduler = await import("../agentcore/autonomous-agent-scheduler.js");
    scheduler.startAutonomousAgent();
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => m.attempts.length === 1);

    m.rejectWork = true;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(m.attempts).toHaveLength(2);
    m.rejectWork = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    scheduler.stopAutonomousAgent();

    expect(m.attempts).toHaveLength(3);
  });

  it("autonomous agent: a granted lease runs the tick inside it", async () => {
    m.granted = true;
    const scheduler = await import("../agentcore/autonomous-agent-scheduler.js");

    scheduler.startAutonomousAgent();
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => m.dbCalls.includes("pendingAction.findMany"));
    scheduler.stopAutonomousAgent();
    await Promise.all(m.ticks);
  });

  it("automation: a granted lease runs the tick inside it", async () => {
    m.granted = true;
    const scheduler = await import("../automation-scheduler.js");

    scheduler.startAutomationScheduler();
    await until(() => m.drainActionOutbox.mock.calls.length > 0);
    scheduler.stopAutomationScheduler();

    // Nothing the tick started may outlive the test: the tick itself, then the
    // imports it left pending, then the jobs behind them.
    await Promise.all(m.ticks);
    await vi.dynamicImportSettled();
    await vi.waitFor(() => expect([...m.detachedJobs].sort()).toEqual(DETACHED_AUTOMATION_JOBS));
  });
});
