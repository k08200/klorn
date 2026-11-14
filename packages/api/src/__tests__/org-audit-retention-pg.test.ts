import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Organization audit log retention against real Postgres: rows older than 400
// days go, rows inside the window stay, across organizations and batches.
// Skipped unless KLORN_TEST_PG_URL is set.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { prisma } from "../db.js";
import { orgAuditCutoff, purgeExpiredOrgAuditEvents } from "../org/audit-retention.js";

const describePg = url ? describe : describe.skip;
const DAY_MS = 86_400_000;
const NOW = new Date();
const orgIds: string[] = [];

async function org(label: string): Promise<string> {
  const created = await prisma.organization.create({
    data: { name: label, slug: `${label}-${randomUUID().slice(0, 12)}` },
    select: { id: true },
  });
  orgIds.push(created.id);
  return created.id;
}

async function audit(orgId: string, ageDays: number, marker: string): Promise<string> {
  const row = await prisma.orgAuditEvent.create({
    data: {
      orgId,
      action: "settings.changed",
      actorUserId: null,
      detail: { marker },
      createdAt: new Date(NOW.getTime() - ageDays * DAY_MS),
    },
    select: { id: true },
  });
  return row.id;
}

describePg("org audit retention (real Postgres)", () => {
  const kept: string[] = [];
  const expired: string[] = [];
  let edge = "";

  beforeAll(async () => {
    const a = await org("retention-a");
    const b = await org("retention-b");
    for (const [orgId, days] of [
      [a, 401],
      [a, 900],
      [b, 450],
      [b, 401],
      [b, 1000],
    ] as const) {
      expired.push(await audit(orgId, days, `old-${days}`));
    }
    for (const [orgId, days] of [
      [a, 0],
      [a, 399],
      [b, 30],
    ] as const) {
      kept.push(await audit(orgId, days, `new-${days}`));
    }
    // Exactly at the cutoff: not older than 400 days, so it stays.
    const row = await prisma.orgAuditEvent.create({
      data: {
        orgId: a,
        action: "settings.changed",
        actorUserId: null,
        createdAt: orgAuditCutoff(NOW),
      },
      select: { id: true },
    });
    edge = row.id;
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.$disconnect();
  });

  it("deletes only rows past the window, in batches smaller than the backlog", async () => {
    const result = await purgeExpiredOrgAuditEvents(NOW, { batchSize: 2, maxBatches: 100 });
    expect(result.complete).toBe(true);
    // Other suites may leave old rows of their own; ours are all gone.
    expect(result.deleted).toBeGreaterThanOrEqual(expired.length);
    const left = await prisma.orgAuditEvent.findMany({
      where: { id: { in: [...expired, ...kept, edge] } },
      select: { id: true },
    });
    expect(left.map((r) => r.id).sort()).toEqual([...kept, edge].sort());
  });

  it("is idempotent: a second run deletes nothing of ours", async () => {
    await purgeExpiredOrgAuditEvents(NOW);
    const left = await prisma.orgAuditEvent.count({ where: { id: { in: [...kept, edge] } } });
    expect(left).toBe(kept.length + 1);
  });
});
