import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TableMock = {
  findMany: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
};

const TABLES = [
  "agentLog",
  "emailProcessingLog",
  "pushDeliveryLog",
  "pushRingEvent",
  "webhookEvent",
  "llmUsageLog",
] as const;

const prismaMock = vi.hoisted(() => {
  const make = () => ({
    findMany: vi.fn(async () => [] as Array<{ id: string }>),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  });
  return {
    agentLog: make(),
    emailProcessingLog: make(),
    pushDeliveryLog: make(),
    pushRingEvent: make(),
    webhookEvent: make(),
    llmUsageLog: make(),
  };
});

vi.mock("../db.js", () => ({ prisma: prismaMock }));

import {
  isLogRetentionEnabled,
  LOG_RETENTION_POLICIES,
  retentionCutoff,
  runLogRetentionSweep,
} from "../log-retention.js";

const NOW = new Date("2026-07-14T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function tableMock(name: string): TableMock {
  return prismaMock[name as (typeof TABLES)[number]] as TableMock;
}

describe("log-retention", () => {
  beforeEach(() => {
    for (const t of TABLES) {
      const m = tableMock(t);
      m.findMany.mockReset();
      m.findMany.mockResolvedValue([]);
      m.deleteMany.mockReset();
      m.deleteMany.mockResolvedValue({ count: 0 });
    }
    delete process.env.LOG_RETENTION_ENABLED;
  });

  afterEach(() => {
    delete process.env.LOG_RETENTION_ENABLED;
  });

  it("is disabled by default (OFF-by-default flag doctrine)", () => {
    expect(isLogRetentionEnabled()).toBe(false);
    process.env.LOG_RETENTION_ENABLED = "true";
    expect(isLogRetentionEnabled()).toBe(true);
    process.env.LOG_RETENTION_ENABLED = "1";
    expect(isLogRetentionEnabled()).toBe(true);
    process.env.LOG_RETENTION_ENABLED = "false";
    expect(isLogRetentionEnabled()).toBe(false);
  });

  it("computes the cutoff as exactly N days before now", () => {
    expect(retentionCutoff(90, NOW).getTime()).toBe(NOW.getTime() - 90 * DAY_MS);
    expect(retentionCutoff(30, NOW).getTime()).toBe(NOW.getTime() - 30 * DAY_MS);
  });

  it("covers every operational log table with a sane window", () => {
    const names = LOG_RETENTION_POLICIES.map((p) => p.name).sort();
    expect(names).toEqual([...TABLES].sort());
    for (const policy of LOG_RETENTION_POLICIES) {
      expect(policy.days).toBeGreaterThanOrEqual(30);
      expect(policy.days).toBeLessThanOrEqual(365);
    }
  });

  it("queries each table's expired rows with a strictly-older-than cutoff", async () => {
    await runLogRetentionSweep(NOW);
    for (const policy of LOG_RETENTION_POLICIES) {
      const m = tableMock(policy.name);
      expect(m.findMany).toHaveBeenCalledTimes(1);
      const arg = m.findMany.mock.calls[0]?.[0] as {
        where: Record<string, { lt: Date }>;
        select: { id: true };
        take: number;
      };
      const cutoff = retentionCutoff(policy.days, NOW);
      expect(arg.where[policy.column]?.lt.getTime()).toBe(cutoff.getTime());
      expect(arg.select).toEqual({ id: true });
      expect(arg.take).toBeGreaterThan(0);
    }
  });

  it("pages deletes in bounded batches until a short page ends the loop", async () => {
    // agentLog returns a full batch, then a short page → two rounds, then stop.
    const agent = tableMock("agentLog");
    const full = Array.from({ length: 3 }, (_, i) => ({ id: `a${i}` }));
    agent.findMany.mockResolvedValueOnce(full).mockResolvedValueOnce([{ id: "a-last" }]);
    agent.deleteMany.mockResolvedValueOnce({ count: 3 }).mockResolvedValueOnce({ count: 1 });

    const result = await runLogRetentionSweep(NOW, 3);

    expect(agent.findMany).toHaveBeenCalledTimes(2);
    expect(agent.deleteMany).toHaveBeenCalledTimes(2);
    expect(agent.deleteMany.mock.calls[0]?.[0]).toEqual({
      where: { id: { in: ["a0", "a1", "a2"] } },
    });
    expect(result.agentLog).toBe(4);
  });

  it("skips the delete entirely when a table has nothing expired", async () => {
    await runLogRetentionSweep(NOW, 3);
    const web = tableMock("webhookEvent");
    expect(web.findMany).toHaveBeenCalledTimes(1);
    expect(web.deleteMany).not.toHaveBeenCalled();
  });

  it("one failing table does not stop the others", async () => {
    tableMock("pushDeliveryLog").findMany.mockRejectedValueOnce(new Error("deadlock"));

    const result = await runLogRetentionSweep(NOW, 3);

    expect(tableMock("agentLog").findMany).toHaveBeenCalledTimes(1);
    expect(tableMock("llmUsageLog").findMany).toHaveBeenCalledTimes(1);
    expect(result.pushDeliveryLog).toBe(-1);
    expect(result.agentLog).toBe(0);
  });
});
