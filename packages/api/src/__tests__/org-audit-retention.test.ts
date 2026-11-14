/**
 * Organization audit log retention: rows older than ORG_AUDIT_RETENTION_DAYS
 * (400) are deleted in bounded, id-paged batches, once a day, by whichever
 * instance holds the "org-audit-retention" scheduler lease. The real-Postgres
 * proof is org-audit-retention-pg.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  captureError: vi.fn(),
  recordSchedulerTick: vi.fn(),
}));

vi.mock("../db.js", () => ({
  prisma: { orgAuditEvent: { findMany: m.findMany, deleteMany: m.deleteMany } },
}));
vi.mock("../sentry.js", () => ({ captureError: m.captureError }));
vi.mock("../scheduler-heartbeat.js", () => ({
  recordSchedulerTick: m.recordSchedulerTick,
  registerScheduler: vi.fn(),
}));

import {
  ORG_AUDIT_RETENTION_DAYS,
  orgAuditCutoff,
  orgAuditRetentionTick,
  purgeExpiredOrgAuditEvents,
} from "../org/audit-retention.js";

const NOW = new Date("2028-01-01T00:00:00.000Z");
const DAY_MS = 86_400_000;

beforeEach(() => {
  m.findMany.mockReset();
  m.deleteMany.mockReset();
  m.captureError.mockReset();
  m.recordSchedulerTick.mockReset();
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
    expect(await orgAuditRetentionTick({ lease: held, purge, now: () => NOW })).toBe("ran");
    expect(held.runExclusive).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledWith(NOW);
    expect(m.recordSchedulerTick).toHaveBeenCalledWith("org-audit-retention");
  });

  it("does no work when another instance holds the lease, and is still alive", async () => {
    const purge = vi.fn(async () => ({ deleted: 0, complete: true }));
    expect(await orgAuditRetentionTick({ lease: lease(false), purge, now: () => NOW })).toBe(
      "skipped",
    );
    expect(purge).not.toHaveBeenCalled();
    expect(m.recordSchedulerTick).toHaveBeenCalledWith("org-audit-retention");
  });

  it("reports a failed purge and records no heartbeat (a dead sweep goes stale)", async () => {
    const purge = vi.fn(async () => {
      throw new Error("db down");
    });
    expect(await orgAuditRetentionTick({ lease: lease(true), purge, now: () => NOW })).toBe(
      "failed",
    );
    expect(m.captureError).toHaveBeenCalledTimes(1);
    expect(m.recordSchedulerTick).not.toHaveBeenCalled();
  });

  it("reports a backlog left by a bounded run", async () => {
    const purge = vi.fn(async () => ({ deleted: 50_000, complete: false }));
    expect(await orgAuditRetentionTick({ lease: lease(true), purge, now: () => NOW })).toBe("ran");
    expect(m.captureError).toHaveBeenCalledTimes(1);
  });
});
