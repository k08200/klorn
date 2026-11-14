/**
 * Organization audit log retention: rows older than ORG_AUDIT_RETENTION_DAYS
 * (400) are deleted in bounded, id-paged batches, once a day, by whichever
 * instance holds the "org-audit-retention" scheduler lease. The real-Postgres
 * proof is org-audit-retention-pg.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  withSystem: vi.fn(),
  captureError: vi.fn(),
  recordSchedulerTick: vi.fn(),
  registerScheduler: vi.fn(),
  markSchedulerDisabled: vi.fn(),
}));

// Every page runs in the system scope (OrgAuditEvent has only the bypass policy).
vi.mock("../db-tenant.js", () => ({ withSystem: m.withSystem }));
vi.mock("../sentry.js", () => ({ captureError: m.captureError }));
vi.mock("../scheduler-heartbeat.js", () => ({
  recordSchedulerTick: m.recordSchedulerTick,
  registerScheduler: m.registerScheduler,
  markSchedulerDisabled: m.markSchedulerDisabled,
}));

import {
  ORG_AUDIT_PURGE_INTERVAL_MS,
  ORG_AUDIT_RETENTION_DAYS,
  orgAuditCutoff,
  orgAuditRetentionTick,
  purgeExpiredOrgAuditEvents,
  startOrgAuditRetentionScheduler,
  stopOrgAuditRetentionScheduler,
} from "../org/audit-retention.js";

const NOW = new Date("2028-01-01T00:00:00.000Z");
const DAY_MS = 86_400_000;

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.withSystem.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ orgAuditEvent: { findMany: m.findMany, deleteMany: m.deleteMany } }),
  );
});

describe("orgAuditCutoff", () => {
  it("is 400 days before now", () => {
    expect(ORG_AUDIT_RETENTION_DAYS).toBe(400);
    expect(orgAuditCutoff(NOW).getTime()).toBe(NOW.getTime() - 400 * DAY_MS);
    expect(orgAuditCutoff(NOW).toISOString()).toBe("2026-11-27T00:00:00.000Z");
  });
});

describe("purgeExpiredOrgAuditEvents", () => {
  it("finds rows strictly older than the cutoff and deletes them by id, page by page", async () => {
    m.findMany
      .mockResolvedValueOnce([{ id: "a" }, { id: "b" }])
      .mockResolvedValueOnce([{ id: "c" }, { id: "d" }])
      .mockResolvedValueOnce([{ id: "e" }]);
    m.deleteMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) => ({
      count: args.where.id.in.length,
    }));
    const result = await purgeExpiredOrgAuditEvents(NOW, { batchSize: 2, maxBatches: 10 });
    expect(result).toEqual({ deleted: 5, complete: true });
    const cutoff = orgAuditCutoff(NOW);
    expect(m.findMany).toHaveBeenCalledTimes(3);
    expect(m.findMany).toHaveBeenNthCalledWith(1, {
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: 2,
    });
    // The delete re-checks the cutoff: an id never deletes a row inside the window.
    expect(m.deleteMany).toHaveBeenNthCalledWith(1, {
      where: { id: { in: ["a", "b"] }, createdAt: { lt: cutoff } },
    });
    expect(m.deleteMany).toHaveBeenCalledTimes(3);
    // One short system-scope transaction per page.
    expect(m.withSystem).toHaveBeenCalledTimes(3);
  });

  it("stops at an empty page without deleting", async () => {
    m.findMany.mockResolvedValueOnce([]);
    expect(await purgeExpiredOrgAuditEvents(NOW)).toEqual({ deleted: 0, complete: true });
    expect(m.deleteMany).not.toHaveBeenCalled();
  });

  it("bounds one run: after maxBatches full pages it stops and reports the backlog", async () => {
    m.findMany.mockResolvedValue([{ id: "x" }, { id: "y" }]);
    m.deleteMany.mockResolvedValue({ count: 2 });
    const result = await purgeExpiredOrgAuditEvents(NOW, { batchSize: 2, maxBatches: 3 });
    expect(result).toEqual({ deleted: 6, complete: false });
    expect(m.findMany).toHaveBeenCalledTimes(3);
  });

  it("a failing delete propagates (the tick reports it)", async () => {
    m.findMany.mockResolvedValueOnce([{ id: "a" }]);
    m.deleteMany.mockRejectedValueOnce(new Error("lock timeout"));
    await expect(purgeExpiredOrgAuditEvents(NOW)).rejects.toThrow("lock timeout");
  });
});

function lease(granted: boolean) {
  return {
    runExclusive: vi.fn(async (work: () => Promise<void>) => {
      if (!granted) return false;
      await work();
      return true;
    }),
  };
}

describe("orgAuditRetentionTick", () => {
  it("purges under the lease and records the heartbeat", async () => {
    const purge = vi.fn(async () => ({ deleted: 3, complete: true }));
    const held = lease(true);
    expect(
      await orgAuditRetentionTick({ lease: held, purge, now: () => NOW, skips: { inARow: 0 } }),
    ).toBe("ran");
    expect(held.runExclusive).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledWith(NOW);
    expect(m.recordSchedulerTick).toHaveBeenCalledWith("org-audit-retention");
  });

  it("does no work when another instance holds the lease, and is still alive", async () => {
    const purge = vi.fn(async () => ({ deleted: 0, complete: true }));
    expect(
      await orgAuditRetentionTick({
        lease: lease(false),
        purge,
        now: () => NOW,
        skips: { inARow: 0 },
      }),
    ).toBe("skipped");
    expect(purge).not.toHaveBeenCalled();
    expect(m.recordSchedulerTick).toHaveBeenCalledWith("org-audit-retention");
  });

  it("reports a failed purge and records no heartbeat (a dead sweep goes stale)", async () => {
    const purge = vi.fn(async () => {
      throw new Error("db down");
    });
    expect(
      await orgAuditRetentionTick({
        lease: lease(true),
        purge,
        now: () => NOW,
        skips: { inARow: 0 },
      }),
    ).toBe("failed");
    expect(m.captureError).toHaveBeenCalledTimes(1);
    expect(m.recordSchedulerTick).not.toHaveBeenCalled();
  });

  it("reports a backlog left by a bounded run", async () => {
    const purge = vi.fn(async () => ({ deleted: 50_000, complete: false }));
    expect(
      await orgAuditRetentionTick({
        lease: lease(true),
        purge,
        now: () => NOW,
        skips: { inARow: 0 },
      }),
    ).toBe("ran");
    expect(m.captureError).toHaveBeenCalledTimes(1);
  });
});

describe("org audit retention — repeated lease refusals", () => {
  it("alerts once when two daily runs in a row are refused, and a run resets the count", async () => {
    const purge = vi.fn(async () => ({ deleted: 0, complete: true }));
    const skips = { inARow: 0 };
    const tick = (granted: boolean) =>
      orgAuditRetentionTick({ lease: lease(granted), purge, now: () => NOW, skips });
    await tick(false);
    expect(m.captureError).not.toHaveBeenCalled();
    await tick(false);
    expect(m.captureError).toHaveBeenCalledTimes(1);
    await tick(false);
    expect(m.captureError).toHaveBeenCalledTimes(1);
    expect(await tick(true)).toBe("ran");
    expect(skips.inARow).toBe(0);
    await tick(false);
    expect(m.captureError).toHaveBeenCalledTimes(1);
  });
});

describe("startOrgAuditRetentionScheduler", () => {
  const saved = process.env.ORG_AUDIT_RETENTION_DISABLED;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopOrgAuditRetentionScheduler();
    vi.useRealTimers();
    if (saved === undefined) delete process.env.ORG_AUDIT_RETENTION_DISABLED;
    else process.env.ORG_AUDIT_RETENTION_DISABLED = saved;
  });

  it("registers a daily heartbeat once, however often it is started", () => {
    delete process.env.ORG_AUDIT_RETENTION_DISABLED;
    startOrgAuditRetentionScheduler();
    startOrgAuditRetentionScheduler();
    expect(m.registerScheduler).toHaveBeenCalledTimes(1);
    expect(m.registerScheduler).toHaveBeenCalledWith(
      "org-audit-retention",
      ORG_AUDIT_PURGE_INTERVAL_MS,
    );
    expect(m.markSchedulerDisabled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stop clears its timers, so a later start schedules again", () => {
    delete process.env.ORG_AUDIT_RETENTION_DISABLED;
    startOrgAuditRetentionScheduler();
    stopOrgAuditRetentionScheduler();
    expect(vi.getTimerCount()).toBe(0);
    startOrgAuditRetentionScheduler();
    expect(m.registerScheduler).toHaveBeenCalledTimes(2);
  });

  it("ORG_AUDIT_RETENTION_DISABLED pauses it: disabled-by-design, no timer, no purge", () => {
    process.env.ORG_AUDIT_RETENTION_DISABLED = "true";
    startOrgAuditRetentionScheduler();
    expect(m.markSchedulerDisabled).toHaveBeenCalledWith("org-audit-retention");
    expect(m.registerScheduler).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
