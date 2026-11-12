import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Both cross-instance schedulers take their tick through the scheduler lease,
// each under its own name, and a refused lease means the tick does no work at
// all (the lease itself logs the skip, see scheduler-lease.test.ts).

const m = vi.hoisted(() => ({
  granted: false,
  rejectWork: false,
  leases: [] as string[],
  attempts: [] as string[],
  dbCalls: [] as string[],
  drainActionOutbox: vi.fn(async () => ({ completed: 0, retried: 0, dead: 0, reclaimed: 0 })),
}));

vi.mock("../scheduler-lease.js", () => ({
  createSchedulerLease: ({ name }: { name: string }) => {
    m.leases.push(name);
    return {
      runExclusive: async (work: () => Promise<void>) => {
        m.attempts.push(name);
        if (m.rejectWork) throw new Error("escaped the tick");
        if (!m.granted) return false;
        await work();
        return true;
      },
    };
  },
}));
vi.mock("../agentcore/action-outbox.js", () => ({ drainActionOutbox: m.drainActionOutbox }));
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

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await vi.advanceTimersByTimeAsync(10);
  expect(condition()).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  m.granted = false;
  m.rejectWork = false;
  m.leases.length = 0;
  m.attempts.length = 0;
  m.dbCalls.length = 0;
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

// The granted cases come last: a granted automation tick starts fire-and-forget
// jobs whose table calls land after the test ends.
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
  });

  it("automation: a granted lease runs the tick inside it", async () => {
    m.granted = true;
    const scheduler = await import("../automation-scheduler.js");

    scheduler.startAutomationScheduler();
    await until(() => m.drainActionOutbox.mock.calls.length > 0);
    scheduler.stopAutomationScheduler();
  });
});
