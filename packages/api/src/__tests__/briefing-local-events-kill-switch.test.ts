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
