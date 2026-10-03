/**
 * C7: the one calendar read path (pim/calendar-read.ts). Every list or count of
 * CalendarEvent rows that must show an invite once goes through it: the scope
 * (the C2 kill switch), the dedupe and the cap that applies after the dedupe.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ findMany: vi.fn(), count: vi.fn() }));

vi.mock("../db.js", () => {
  const prisma = { calendarEvent: { findMany: m.findMany, count: m.count } };
  return { prisma, db: prisma };
});

import { unifiedCalendarReadEnabled } from "../config.js";
import { countCalendarRows, readCalendarRows } from "../pim/calendar-read.js";

const START = new Date("2026-10-01T03:00:00.000Z");
const END = new Date("2026-10-08T03:00:00.000Z");

function row(id: string, externalId: string | null, sourceAccountId: string | null, hour = 4) {
  return {
    id,
    title: `Event ${id}`,
    description: null,
    location: null,
    startTime: new Date(Date.UTC(2026, 9, 1, hour)),
    endTime: new Date(Date.UTC(2026, 9, 1, hour + 1)),
    allDay: false,
    provider: externalId === null ? "LOCAL" : "GOOGLE",
    externalId,
    sourceAccountId,
  };
}

function firstWhere(mock: typeof m.findMany): Record<string, unknown> {
  return (mock.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
}

beforeEach(() => {
  m.findMany.mockReset();
  m.count.mockReset();
  m.findMany.mockResolvedValue([]);
  m.count.mockResolvedValue(0);
});
afterEach(() => {
  delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
  delete process.env.UNIFIED_CALENDAR_READ_ENABLED;
});

describe("unifiedCalendarReadEnabled", () => {
  it("is off when unset, empty or falsy", () => {
    for (const value of [undefined, "", "false", "0", "off", "no", "maybe"]) {
      if (value === undefined) delete process.env.UNIFIED_CALENDAR_READ_ENABLED;
      else process.env.UNIFIED_CALENDAR_READ_ENABLED = value;
      expect(unifiedCalendarReadEnabled()).toBe(false);
    }
  });

  it("parses leniently and is read at request time", () => {
    for (const value of ["true", "1", "yes", "on", " TRUE "]) {
      process.env.UNIFIED_CALENDAR_READ_ENABLED = value;
      expect(unifiedCalendarReadEnabled()).toBe(true);
    }
    delete process.env.UNIFIED_CALENDAR_READ_ENABLED;
    expect(unifiedCalendarReadEnabled()).toBe(false);
  });
});

describe("readCalendarRows — scope (the C2 kill switch)", () => {
  it("reads primary and LOCAL rows only while the linked sync is off", async () => {
    await readCalendarRows({ userId: "u1", when: { startTime: { gte: START } } });
    expect(firstWhere(m.findMany)).toMatchObject({
      userId: "u1",
      startTime: { gte: START },
      sourceAccountId: null,
    });
  });

  it("does not narrow the read once the linked sync is on", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    await readCalendarRows({ userId: "u1", when: { startTime: { gte: START } } });
    expect(firstWhere(m.findMany)).not.toHaveProperty("sourceAccountId");
  });

  it("never lets the caller's time predicate override the user scope", async () => {
    await readCalendarRows({
      userId: "u1",
      when: { userId: "someone-else", sourceAccountId: "acct-9" },
    });
    expect(firstWhere(m.findMany)).toMatchObject({ userId: "u1", sourceAccountId: null });
  });
});

describe("readCalendarRows — dedupe", () => {
  it("shows an invite that sits in the primary and a linked calendar once, primary copy first", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    m.findMany.mockResolvedValue([row("linked", "g-1", "acct-1"), row("primary", "g-1", null)]);

    const rows = await readCalendarRows({ userId: "u1", when: {} });

    expect(rows.map((r) => r.id)).toEqual(["primary"]);
  });

  it("keeps two different events and rows with no external id", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    m.findMany.mockResolvedValue([
      row("a", "g-1", null, 4),
      row("b", "g-2", "acct-1", 5),
      row("c", null, null, 6),
      row("d", null, null, 7),
    ]);

    const rows = await readCalendarRows({ userId: "u1", when: {} });

    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("applies the cap after the dedupe, so copies do not spend it (flag on)", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    m.findMany.mockResolvedValue([
      row("p1", "g-1", null, 4),
      row("l1", "g-1", "acct-1", 4),
      row("p2", "g-2", null, 5),
      row("l2", "g-2", "acct-1", 5),
      row("p3", "g-3", null, 6),
    ]);

    const rows = await readCalendarRows({ userId: "u1", when: {}, limit: 3 });

    expect(rows.map((r) => r.id)).toEqual(["p1", "p2", "p3"]);
    // The query itself must not cap: a cap before the dedupe is the C2 gap.
    expect((m.findMany.mock.calls[0]?.[0] as { take?: number }).take).toBeUndefined();
  });

  it("lets the database cap the query while no linked row can be visible (flag off, identical to main)", async () => {
    m.findMany.mockResolvedValue([row("p1", "g-1", null, 4), row("p2", "g-2", null, 5)]);

    const rows = await readCalendarRows({ userId: "u1", when: {}, limit: 2 });

    expect((m.findMany.mock.calls[0]?.[0] as { take?: number }).take).toBe(2);
    expect(rows.map((r) => r.id)).toEqual(["p1", "p2"]);
  });

  it("orders by start time and selects only what the readers need", async () => {
    await readCalendarRows({ userId: "u1", when: {} });
    const arg = m.findMany.mock.calls[0]?.[0] as {
      orderBy: unknown;
      select: Record<string, true>;
    };
    expect(arg.orderBy).toEqual({ startTime: "asc" });
    expect(Object.keys(arg.select).sort()).toEqual(
      [
        "allDay",
        "description",
        "endTime",
        "externalId",
        "id",
        "location",
        "provider",
        "sourceAccountId",
        "startTime",
        "title",
      ].sort(),
    );
  });
});

describe("countCalendarRows", () => {
  it("counts in the database, with the scope, while the linked sync is off (identical to main)", async () => {
    m.count.mockResolvedValue(4);

    const n = await countCalendarRows({ userId: "u1", when: { startTime: { gte: START } } });

    expect(n).toBe(4);
    expect(m.findMany).not.toHaveBeenCalled();
    expect(m.count.mock.calls[0]?.[0]).toEqual({
      where: {
        userId: "u1",
        startTime: { gte: START },
        sourceAccountId: null,
        // C4/C3: the kill switch also hides OUTLOOK, ICLOUD and NAVER rows while their flags are off.
        provider: { notIn: ["OUTLOOK", "ICLOUD", "NAVER"] },
      },
    });
  });

  it("counts an invite in two calendars once when the linked sync is on", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    m.findMany.mockResolvedValue([
      row("p1", "g-1", null),
      row("l1", "g-1", "acct-1"),
      row("p2", "g-2", null),
      row("l3", "g-3", "acct-1"),
    ]);

    const n = await countCalendarRows({ userId: "u1", when: { startTime: { lte: END } } });

    expect(n).toBe(3);
    expect(m.count).not.toHaveBeenCalled();
    expect(firstWhere(m.findMany)).not.toHaveProperty("sourceAccountId");
  });

  it("with the linked sync on and no duplicate, counts exactly what the database counts", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    m.findMany.mockResolvedValue([
      row("a", "g-1", null),
      row("b", "g-2", null),
      row("c", null, null),
    ]);

    expect(await countCalendarRows({ userId: "u1", when: {} })).toBe(3);
  });
});
