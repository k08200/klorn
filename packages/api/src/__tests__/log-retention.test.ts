import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deleteManySpies = vi.hoisted(() => ({
  agentLog: vi.fn(async () => ({ count: 1 })),
  emailProcessingLog: vi.fn(async () => ({ count: 1 })),
  pushDeliveryLog: vi.fn(async () => ({ count: 1 })),
  pushRingEvent: vi.fn(async () => ({ count: 1 })),
  webhookEvent: vi.fn(async () => ({ count: 1 })),
  llmUsageLog: vi.fn(async () => ({ count: 1 })),
}));

vi.mock("../db.js", () => ({
  prisma: {
    agentLog: { deleteMany: deleteManySpies.agentLog },
    emailProcessingLog: { deleteMany: deleteManySpies.emailProcessingLog },
    pushDeliveryLog: { deleteMany: deleteManySpies.pushDeliveryLog },
    pushRingEvent: { deleteMany: deleteManySpies.pushRingEvent },
    webhookEvent: { deleteMany: deleteManySpies.webhookEvent },
    llmUsageLog: { deleteMany: deleteManySpies.llmUsageLog },
  },
}));

import {
  isLogRetentionEnabled,
  LOG_RETENTION_POLICIES,
  retentionCutoff,
  runLogRetentionSweep,
} from "../log-retention.js";

const NOW = new Date("2026-07-14T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

describe("log-retention", () => {
  beforeEach(() => {
    for (const spy of Object.values(deleteManySpies)) {
      spy.mockClear();
      spy.mockImplementation(async () => ({ count: 1 }));
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
    expect(names).toEqual(
      [
        "agentLog",
        "emailProcessingLog",
        "llmUsageLog",
        "pushDeliveryLog",
        "pushRingEvent",
        "webhookEvent",
      ].sort(),
    );
    for (const policy of LOG_RETENTION_POLICIES) {
      expect(policy.days).toBeGreaterThanOrEqual(30);
      expect(policy.days).toBeLessThanOrEqual(365);
    }
  });

  it("sweeps every table with a strictly-older-than cutoff", async () => {
    const result = await runLogRetentionSweep(NOW);

    for (const policy of LOG_RETENTION_POLICIES) {
      const spy = deleteManySpies[policy.name as keyof typeof deleteManySpies];
      expect(spy).toHaveBeenCalledTimes(1);
      const arg = spy.mock.calls[0]?.[0] as Record<string, Record<string, { lt: Date }>>;
      const cutoff = retentionCutoff(policy.days, NOW);
      expect(arg.where[policy.column]?.lt.getTime()).toBe(cutoff.getTime());
    }
    expect(Object.keys(result).sort()).toEqual(LOG_RETENTION_POLICIES.map((p) => p.name).sort());
  });

  it("one failing table does not stop the others", async () => {
    deleteManySpies.pushDeliveryLog.mockRejectedValueOnce(new Error("deadlock"));

    const result = await runLogRetentionSweep(NOW);

    // Every other table still swept; the failed one reports -1, not a throw.
    expect(deleteManySpies.agentLog).toHaveBeenCalledTimes(1);
    expect(deleteManySpies.llmUsageLog).toHaveBeenCalledTimes(1);
    expect(result.pushDeliveryLog).toBe(-1);
    expect(result.agentLog).toBe(1);
  });
});
