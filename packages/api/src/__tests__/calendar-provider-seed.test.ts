/**
 * C1: the demo account's sample calendar events have no Google id, so they
 * must be written as LOCAL — never GOOGLE (the plan's backfill rule, applied
 * to new rows as well).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calendarCreateMany = vi.hoisted(() => vi.fn(async () => ({ count: 2 })));

vi.mock("../db.js", () => {
  const generic = {
    createMany: vi.fn(async () => ({ count: 0 })),
    count: vi.fn(async () => 0),
    upsert: vi.fn(async () => ({})),
  };
  const prisma = new Proxy({} as Record<string, unknown>, {
    get: (_target, model) =>
      model === "calendarEvent" ? { createMany: calendarCreateMany } : generic,
  });
  return { prisma, db: prisma };
});

const { ensureDemoUser } = await import("../auth.js");

describe("demo seed — sample calendar events", () => {
  beforeEach(() => {
    calendarCreateMany.mockClear();
    process.env.ENABLE_DEMO_USER = "true";
  });
  afterEach(() => {
    delete process.env.ENABLE_DEMO_USER;
  });

  it("writes every sample event as LOCAL with no externalId and no linked account", async () => {
    await ensureDemoUser();
    const arg = calendarCreateMany.mock.calls[0]?.[0] as { data: Array<Record<string, unknown>> };
    expect(arg.data).toHaveLength(2);
    for (const row of arg.data) {
      expect(row).toMatchObject({ provider: "LOCAL", externalId: null, sourceAccountId: null });
      expect(row).not.toHaveProperty("googleId");
    }
  });

  it("seeds nothing when demo access is disabled", async () => {
    delete process.env.ENABLE_DEMO_USER;
    await ensureDemoUser();
    expect(calendarCreateMany).not.toHaveBeenCalled();
  });
});
