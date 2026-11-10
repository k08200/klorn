/**
 * The briefing reads upcoming events from the local calendar table. With
 * LINKED_CALENDAR_SYNC_ENABLED off it must read primary and LOCAL rows only (C2
 * kill switch); with it on, an invite present in the primary and a linked
 * calendar is one line (the existing (title, day) collapse already guarantees it).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, findMany: vi.fn() }));

vi.mock("../db.js", () => {
  const prisma = { calendarEvent: { findMany: m.findMany } };
  return { prisma, db: prisma };
});

import { listLocalBriefingEvents } from "../pim/briefing.js";

const NOW = new Date("2026-10-01T03:00:00.000Z");

function row(id: string, sourceAccountId: string | null) {
  return {
    id,
    title: "Design review",
    description: null,
    location: null,
    startTime: new Date(NOW.getTime() + 3_600_000),
    endTime: new Date(NOW.getTime() + 7_200_000),
    provider: "GOOGLE",
    externalId: "g-invite",
    sourceAccountId,
  };
}

beforeEach(() => {
  m.findMany.mockReset();
  m.findMany.mockImplementation(async () => m.rows);
  m.rows = [];
});
afterEach(() => {
  delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
});

describe("listLocalBriefingEvents — kill switch", () => {
  it("queries primary and LOCAL rows only while the flag is off", async () => {
    delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
    await listLocalBriefingEvents("u1", NOW);
    const arg = m.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(arg.where.sourceAccountId).toBeNull();
  });

  it("does not narrow the query once the flag is on", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    await listLocalBriefingEvents("u1", NOW);
    const arg = m.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(arg.where).not.toHaveProperty("sourceAccountId");
  });

  it("lists an invite that is in the primary and a linked calendar once", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    m.rows = [row("linked", "acct-1"), row("primary", null)];
    const { events } = await listLocalBriefingEvents("u1", NOW);
    expect(events).toHaveLength(1);
  });
});

describe("listLocalBriefingEvents — the cap applies after the dedupe (C7)", () => {
  const BRIEFING_CAP = 20;

  function distinct(i: number, sourceAccountId: string | null) {
    return {
      ...row(`${sourceAccountId ?? "p"}-${i}`, sourceAccountId),
      title: `Meeting ${String(i).padStart(2, "0")}`,
      externalId: `g-${i}`,
      startTime: new Date(NOW.getTime() + (i + 1) * 3_600_000),
      endTime: new Date(NOW.getTime() + (i + 1) * 3_600_000 + 1_800_000),
    };
  }

  it("spends the cap on 20 distinct events, not on linked copies of the first 10", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    m.rows = Array.from({ length: 30 }, (_, i) => [
      distinct(i, null),
      distinct(i, "acct-1"),
    ]).flat();

    const { events } = (await listLocalBriefingEvents("u1", NOW)) as {
      events: Array<{ summary: string }>;
    };

    expect(events).toHaveLength(BRIEFING_CAP);
    expect(events.map((e) => e.summary)).toEqual(
      Array.from({ length: BRIEFING_CAP }, (_, i) => `Meeting ${String(i).padStart(2, "0")}`),
    );
    const arg = m.findMany.mock.calls[0]?.[0] as { take?: number };
    expect(arg.take).toBeUndefined();
  });

  it("still caps the query itself while no linked row can be visible (flag off, identical to main)", async () => {
    delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
    m.rows = Array.from({ length: 5 }, (_, i) => distinct(i, null));

    const { events } = await listLocalBriefingEvents("u1", NOW);

    expect((m.findMany.mock.calls[0]?.[0] as { take?: number }).take).toBe(BRIEFING_CAP);
    expect(events).toHaveLength(5);
  });
});
