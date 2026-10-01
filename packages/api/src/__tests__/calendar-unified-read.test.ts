/**
 * C7: with UNIFIED_CALENDAR_READ_ENABLED on, `list_events` and
 * `check_calendar_conflicts` (chat and MCP both go through listEvents /
 * checkConflicts) read CalendarEvent rows through the one read path. With it off
 * nothing changes: list_events calls Google live and no row is read.
 * The free/busy half of the conflict check, and every attendee free/busy, stays live.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  eventsList: vi.fn(),
  calendarListList: vi.fn(),
  freebusyQuery: vi.fn(),
  getAuthedClient: vi.fn(),
  markGoogleTokenForReconnect: vi.fn(async () => {}),
  automationConfigFindUnique: vi.fn(),
  calendarFindMany: vi.fn(),
  linkedRows: [] as unknown[],
}));

vi.mock("googleapis", () => ({
  google: {
    calendar: vi.fn(() => ({
      events: { list: m.eventsList },
      calendarList: { list: m.calendarListList },
      freebusy: { query: m.freebusyQuery },
    })),
  },
}));

vi.mock("../mail/gmail.js", () => ({
  getAuthedClient: m.getAuthedClient,
  buildLinkedCalendarClient: (
    _userId: string,
    row: { id: string; email: string; client: unknown },
  ) => ({ client: row.client, id: row.id, email: row.email }),
  isGoogleAuthError: (e: { response?: { status?: number } }) => e?.response?.status === 401,
  markGoogleTokenForReconnect: m.markGoogleTokenForReconnect,
  markLinkedCalendarForReconnect: vi.fn(async () => {}),
}));

vi.mock("../db.js", () => ({
  prisma: {
    automationConfig: { findUnique: m.automationConfigFindUnique },
    linkedCalendarAccount: { findMany: vi.fn(async () => m.linkedRows) },
    calendarEvent: { findMany: m.calendarFindMany, count: vi.fn(async () => 0) },
  },
}));

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { CALENDAR_TOOLS, checkAttendeeBusy, checkConflicts, listEvents } from "../pim/calendar.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const SPAN_DAYS = 31; // MAX_EVENT_SPAN_DAYS, UPCOMING_HORIZON_DAYS and MAX_CONFLICT_WINDOW_DAYS
const NOT_CONNECTED = "Google Calendar not connected. Please connect your Google account first.";
// 14:00-15:00 KST on 2026-10-03.
const START = "2026-10-03T14:00:00+09:00";
const END = "2026-10-03T15:00:00+09:00";

interface RowInit {
  id: string;
  title?: string;
  startTime: string;
  endTime: string;
  externalId?: string | null;
  sourceAccountId?: string | null;
  allDay?: boolean;
  description?: string | null;
  location?: string | null;
}

function row(init: RowInit) {
  const externalId = init.externalId === undefined ? `g-${init.id}` : init.externalId;
  return {
    id: init.id,
    title: init.title ?? `Event ${init.id}`,
    description: init.description ?? null,
    location: init.location ?? null,
    startTime: new Date(init.startTime),
    endTime: new Date(init.endTime),
    allDay: init.allDay ?? false,
    provider: externalId === null ? "LOCAL" : "GOOGLE",
    externalId,
    sourceAccountId: init.sourceAccountId ?? null,
  };
}

function toolDescription(name: string): string {
  const tool = CALENDAR_TOOLS.find((t) => t.function.name === name);
  return tool?.function.description ?? "";
}

function enableUnified() {
  process.env.UNIFIED_CALENDAR_READ_ENABLED = "true";
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  m.linkedRows = [];
  m.getAuthedClient.mockResolvedValue({ tag: "primary" });
  m.automationConfigFindUnique.mockResolvedValue({ timezone: "Asia/Seoul" });
  m.eventsList.mockResolvedValue({ data: { items: [] } });
  m.calendarListList.mockResolvedValue({
    data: { items: [{ id: "primary", primary: true, accessRole: "owner", summary: "me" }] },
  });
  m.freebusyQuery.mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } });
  m.calendarFindMany.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.UNIFIED_CALENDAR_READ_ENABLED;
  delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
});

describe("listEvents — flag off (identical to main)", () => {
  it("still lists from Google live and reads no row", async () => {
    m.eventsList.mockResolvedValue({
      data: {
        items: [
          {
            id: "evt-1",
            summary: "Standup",
            start: { dateTime: "2026-10-02T10:00:00+09:00" },
            end: { dateTime: "2026-10-02T10:30:00+09:00" },
          },
        ],
      },
    });

    const result = await listEvents("u1", 5);

    expect(m.eventsList).toHaveBeenCalledTimes(1);
    expect(m.calendarFindMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      events: [
        {
          id: "evt-1",
          summary: '<untrusted_content source="calendar:summary">Standup</untrusted_content>',
          start: "2026-10-02T10:00:00+09:00",
          end: "2026-10-02T10:30:00+09:00",
          location: "",
          description: "",
        },
      ],
    });
  });

  it("leaves both tool descriptions exactly as they were", () => {
    expect(toolDescription("list_events")).toBe(
      "List upcoming events from the user's Google Calendar",
    );
    expect(toolDescription("check_calendar_conflicts")).toBe(
      "Check if a time range has any conflicting events. Use before creating events to avoid double-booking.",
    );
  });
});

describe("listEvents — flag on", () => {
  beforeEach(enableUnified);

  it("reads rows, not Google, and reports provider and readOnly per event", async () => {
    m.calendarFindMany.mockResolvedValue([
      row({
        id: "r1",
        title: "Standup",
        startTime: "2026-10-02T01:00:00Z",
        endTime: "2026-10-02T01:30:00Z",
        description: "Daily",
        location: "Room 4",
      }),
    ]);

    const result = await listEvents("u1", 10);

    expect(m.eventsList).not.toHaveBeenCalled();
    expect(result).toEqual({
      events: [
        {
          id: "g-r1",
          summary: '<untrusted_content source="calendar:summary">Standup</untrusted_content>',
          start: "2026-10-02T10:00:00+09:00",
          end: "2026-10-02T10:30:00+09:00",
          allDay: false,
          location: '<untrusted_content source="calendar:location">Room 4</untrusted_content>',
          description: '<untrusted_content source="calendar:description">Daily</untrusted_content>',
          provider: "GOOGLE",
          readOnly: false,
        },
      ],
    });
  });

  it("asks for events that have not ended yet, bounded on both sides, through the scope", async () => {
    await listEvents("u1", 10);

    const arg = m.calendarFindMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      orderBy: unknown;
    };
    expect(arg.where).toEqual({
      userId: "u1",
      // A lower bound so the (userId, startTime) index is used, an upper one so
      // the read cannot load every future row.
      startTime: {
        gte: new Date(NOW.getTime() - SPAN_DAYS * DAY_MS),
        lt: new Date(NOW.getTime() + SPAN_DAYS * DAY_MS),
      },
      // A timed event is upcoming until it ends; an all-day one (stored as UTC
      // midnight dates) until the end of its last date in the user's zone.
      AND: [
        {
          OR: [
            { allDay: false, endTime: { gt: NOW } },
            { allDay: true, endTime: { gt: new Date("2026-10-01T00:00:00.000Z") } },
          ],
        },
      ],
      sourceAccountId: null,
    });
    expect(arg.orderBy).toEqual({ startTime: "asc" });
  });

  it("cuts all-day events off at the end of their date in the user's zone (Los Angeles is still on Sep 30)", async () => {
    m.automationConfigFindUnique.mockResolvedValue({ timezone: "America/Los_Angeles" });

    await listEvents("u1", 10);

    const where = (m.calendarFindMany.mock.calls[0]?.[0] as { where: { AND: unknown[] } }).where;
    expect(where.AND).toEqual([
      {
        OR: [
          { allDay: false, endTime: { gt: NOW } },
          // 2026-10-01T00:00Z is 17:00 on Sep 30 in Los Angeles.
          { allDay: true, endTime: { gt: new Date("2026-09-30T00:00:00.000Z") } },
        ],
      },
    ]);
  });

  it("shows a linked calendar's event read-only with no id to delete by, once even when it is also in the primary", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    m.calendarFindMany.mockResolvedValue([
      row({
        id: "dup-linked",
        externalId: "g-invite",
        sourceAccountId: "acct-1",
        startTime: "2026-10-02T01:00:00Z",
        endTime: "2026-10-02T02:00:00Z",
      }),
      row({
        id: "dup-primary",
        externalId: "g-invite",
        startTime: "2026-10-02T01:00:00Z",
        endTime: "2026-10-02T02:00:00Z",
      }),
      row({
        id: "only-linked",
        sourceAccountId: "acct-1",
        startTime: "2026-10-02T03:00:00Z",
        endTime: "2026-10-02T04:00:00Z",
      }),
    ]);

    const { events } = (await listEvents("u1", 10)) as {
      events: Array<{ id: string | null; readOnly: boolean }>;
    };

    expect(events.map((e) => [e.id, e.readOnly])).toEqual([
      ["g-invite", false],
      [null, true],
    ]);
  });

  it("applies max_results after the dedupe", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    m.calendarFindMany.mockResolvedValue([
      row({
        id: "p1",
        externalId: "g-1",
        startTime: "2026-10-02T01:00:00Z",
        endTime: "2026-10-02T02:00:00Z",
      }),
      row({
        id: "l1",
        externalId: "g-1",
        sourceAccountId: "a",
        startTime: "2026-10-02T01:00:00Z",
        endTime: "2026-10-02T02:00:00Z",
      }),
      row({
        id: "p2",
        externalId: "g-2",
        startTime: "2026-10-02T03:00:00Z",
        endTime: "2026-10-02T04:00:00Z",
      }),
    ]);

    const { events } = (await listEvents("u1", 2)) as { events: Array<{ id: string | null }> };

    // The copy in the linked calendar did not take a slot from the second event.
    expect(events.map((e) => e.id)).toEqual(["g-1", "g-2"]);
  });

  it.each([
    "Asia/Seoul",
    "America/Los_Angeles",
    "UTC",
  ])("writes an all-day event as its stored UTC dates, end exclusive, whatever the zone (%s)", async (timezone) => {
    m.automationConfigFindUnique.mockResolvedValue({ timezone });
    // The sync stores an all-day event as UTC midnight of its date (Oct 3, end Oct 4).
    m.calendarFindMany.mockResolvedValue([
      row({
        id: "allday",
        allDay: true,
        startTime: "2026-10-03T00:00:00Z",
        endTime: "2026-10-04T00:00:00Z",
      }),
    ]);

    const { events } = (await listEvents("u1", 10)) as {
      events: Array<{ start: string; end: string; allDay: boolean }>;
    };

    expect(events[0]).toMatchObject({ start: "2026-10-03", end: "2026-10-04", allDay: true });
  });

  it("gives a local-only event a null id (Google has no copy to delete)", async () => {
    m.calendarFindMany.mockResolvedValue([
      row({
        id: "local",
        externalId: null,
        startTime: "2026-10-02T01:00:00Z",
        endTime: "2026-10-02T02:00:00Z",
      }),
    ]);

    const { events } = (await listEvents("u1", 10)) as {
      events: Array<{ id: string | null; provider: string; readOnly: boolean }>;
    };

    expect(events[0]).toMatchObject({ id: null, provider: "LOCAL", readOnly: false });
  });

  it("answers an empty list when the calendar is connected and nothing is upcoming", async () => {
    expect(await listEvents("u1", 10)).toEqual({ events: [] });
  });

  it("keeps the not-connected answer when there are no rows and no Google connection", async () => {
    m.getAuthedClient.mockResolvedValue(null);

    expect(await listEvents("u1", 10)).toEqual({ error: NOT_CONNECTED });
    expect(m.eventsList).not.toHaveBeenCalled();
  });

  it("still tells the model to reconnect when the primary Google token is gone but rows exist", async () => {
    m.getAuthedClient.mockResolvedValue(null);
    m.calendarFindMany.mockResolvedValue([
      row({ id: "r1", startTime: "2026-10-02T01:00:00Z", endTime: "2026-10-02T02:00:00Z" }),
    ]);

    const result = (await listEvents("u1", 10)) as { events: unknown[]; warning?: string };

    expect(result.events).toHaveLength(1);
    expect(result.warning).toContain(NOT_CONNECTED);
    expect(result.warning).toContain("last sync");
  });

  it("adds no warning while Google is connected", async () => {
    m.calendarFindMany.mockResolvedValue([
      row({ id: "r1", startTime: "2026-10-02T01:00:00Z", endTime: "2026-10-02T02:00:00Z" }),
    ]);

    expect(await listEvents("u1", 10)).not.toHaveProperty("warning");
  });

  it("still returns the rows it read, with the reconnect warning, when the connection check itself throws", async () => {
    m.getAuthedClient.mockRejectedValue(new Error("db down"));
    m.calendarFindMany.mockResolvedValue([
      row({ id: "r1", startTime: "2026-10-02T01:00:00Z", endTime: "2026-10-02T02:00:00Z" }),
    ]);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = (await listEvents("u1", 10)) as { events: unknown[]; warning?: string };

    expect(result.events).toHaveLength(1);
    expect(result.warning).toContain(NOT_CONNECTED);
    spy.mockRestore();
  });

  it("answers an error, never a throw, when the rows cannot be read", async () => {
    m.calendarFindMany.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await listEvents("u1", 10);

    expect(result).toEqual({ error: "Could not read the synced calendar right now." });
    spy.mockRestore();
  });
});

describe("checkConflicts — flag off (identical to main)", () => {
  it("reads no row", async () => {
    const result = await checkConflicts("u1", START, END);

    expect(m.calendarFindMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ hasConflicts: false, conflicts: [], scope: "all_calendars" });
  });
});

describe("checkConflicts — flag on", () => {
  beforeEach(enableUnified);

  it("reports a row that overlaps the window, with provider and readOnly, and still asks Google free/busy", async () => {
    m.calendarFindMany.mockResolvedValue([
      row({
        id: "r1",
        title: "Board",
        startTime: "2026-10-03T05:30:00Z",
        endTime: "2026-10-03T06:30:00Z",
      }),
    ]);

    const result = (await checkConflicts("u1", START, END)) as {
      hasConflicts: boolean;
      conflicts: Array<Record<string, unknown>>;
      message: string;
    };

    expect(m.freebusyQuery).toHaveBeenCalledTimes(1);
    expect(result.hasConflicts).toBe(true);
    expect(result.conflicts).toEqual([
      {
        start: "2026-10-03T14:30:00+09:00",
        end: "2026-10-03T15:30:00+09:00",
        calendar: "primary",
        provider: "GOOGLE",
        readOnly: false,
      },
    ]);
    expect(result.message).toBe("Found 1 conflicting event(s) in this time range.");
  });

  it("never hands an event's title to the agent: a work calendar's meeting names stay out of the answer", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    m.calendarFindMany.mockResolvedValue([
      row({
        id: "w1",
        title: "Layoff planning",
        sourceAccountId: "acct-1",
        startTime: "2026-10-03T05:30:00Z",
        endTime: "2026-10-03T06:30:00Z",
      }),
      row({
        id: "p1",
        title: "Dentist",
        startTime: "2026-10-03T05:00:00Z",
        endTime: "2026-10-03T05:30:00Z",
      }),
    ]);

    const result = await checkConflicts("u1", START, END);

    const sent = JSON.stringify(result);
    expect(sent).not.toContain("Layoff planning");
    expect(sent).not.toContain("Dentist");
    expect(sent).not.toContain("summary");
  });

  it("queries the overlap of the window for timed events only, through the scope", async () => {
    await checkConflicts("u1", START, END);

    const where = (m.calendarFindMany.mock.calls[0]?.[0] as { where: Record<string, unknown> })
      .where;
    expect(where).toEqual({
      userId: "u1",
      // The lower bound keeps the (userId, startTime) index range finite.
      startTime: {
        gte: new Date(new Date("2026-10-03T05:00:00.000Z").getTime() - SPAN_DAYS * DAY_MS),
        lt: new Date("2026-10-03T06:00:00.000Z"),
      },
      endTime: { gt: new Date("2026-10-03T05:00:00.000Z") },
      allDay: false,
      sourceAccountId: null,
    });
  });

  it("does not skip a long event that began up to a month before the window and is still running", async () => {
    await checkConflicts("u1", START, END);

    const where = (
      m.calendarFindMany.mock.calls[0]?.[0] as {
        where: { startTime: { gte: Date }; endTime: { gt: Date } };
      }
    ).where;
    const windowStart = new Date("2026-10-03T05:00:00.000Z").getTime();
    // startTime >= windowStart - 31 days AND endTime > windowStart: an event that
    // started 30 days ago and has not ended is read; only one running longer than the
    // named span (31 days) before the window is not.
    expect(where.startTime.gte.getTime()).toBeLessThanOrEqual(windowStart - 30 * DAY_MS);
    expect(where.endTime.gt.getTime()).toBe(windowStart);
  });

  it("list_events likewise reads an event that began a month ago and has not ended", async () => {
    enableUnified();
    await listEvents("u1", 10);

    const where = (m.calendarFindMany.mock.calls[0]?.[0] as { where: { startTime: { gte: Date } } })
      .where;
    expect(where.startTime.gte.getTime()).toBeLessThanOrEqual(NOW.getTime() - 30 * DAY_MS);
  });

  it("reads at most 100 rows, and clamps the window it reads rows for to a month, while free/busy still gets the whole window", async () => {
    await checkConflicts("u1", "2026-10-03T14:00:00+09:00", "2027-03-03T14:00:00+09:00");

    const arg = m.calendarFindMany.mock.calls[0]?.[0] as {
      where: { startTime: { lt: Date } };
      take?: number;
    };
    expect(arg.take).toBe(100);
    expect(arg.where.startTime.lt).toEqual(
      new Date(new Date("2026-10-03T05:00:00.000Z").getTime() + SPAN_DAYS * DAY_MS),
    );
    const freebusy = m.freebusyQuery.mock.calls[0]?.[0] as {
      requestBody: { timeMax: string };
    };
    expect(freebusy.requestBody.timeMax).toBe("2027-03-03T05:00:00.000Z");
  });

  it("applies the 100 cap after the dedupe when linked copies can exist", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    m.calendarFindMany.mockResolvedValue(
      Array.from({ length: 150 }, (_, i) =>
        row({
          id: `p${i}`,
          externalId: `g-${i}`,
          startTime: "2026-10-03T05:00:00Z",
          endTime: "2026-10-03T06:00:00Z",
        }),
      ),
    );

    const result = (await checkConflicts("u1", START, END)) as { conflicts: unknown[] };

    expect(result.conflicts).toHaveLength(100);
    expect((m.calendarFindMany.mock.calls[0]?.[0] as { take?: number }).take).toBeUndefined();
  });

  it("counts two adjacent meetings and the one busy block Google merged them into as two events", async () => {
    m.calendarFindMany.mockResolvedValue([
      row({ id: "a", startTime: "2026-10-03T05:00:00Z", endTime: "2026-10-03T05:30:00Z" }),
      row({ id: "b", startTime: "2026-10-03T05:30:00Z", endTime: "2026-10-03T06:00:00Z" }),
    ]);
    m.freebusyQuery.mockResolvedValue({
      data: {
        calendars: {
          primary: { busy: [{ start: "2026-10-03T05:00:00Z", end: "2026-10-03T06:00:00Z" }] },
        },
      },
    });

    const result = (await checkConflicts("u1", START, END)) as {
      conflicts: unknown[];
      message: string;
    };

    expect(result.conflicts).toHaveLength(2);
    expect(result.message).toBe("Found 2 conflicting event(s) in this time range.");
  });

  it("keeps a busy block that reaches beyond what the rows account for", async () => {
    m.calendarFindMany.mockResolvedValue([
      row({ id: "a", startTime: "2026-10-03T05:00:00Z", endTime: "2026-10-03T05:30:00Z" }),
    ]);
    m.freebusyQuery.mockResolvedValue({
      data: {
        calendars: {
          primary: { busy: [{ start: "2026-10-03T05:00:00Z", end: "2026-10-03T06:00:00Z" }] },
        },
      },
    });

    const result = (await checkConflicts("u1", START, END)) as { conflicts: unknown[] };

    expect(result.conflicts).toHaveLength(2);
  });

  it("does not lose a busy block only Google free/busy can see (a writer calendar the rows do not mirror)", async () => {
    m.calendarListList.mockResolvedValue({
      data: {
        items: [
          { id: "primary", primary: true, accessRole: "owner", summary: "me" },
          { id: "work@group.calendar.google.com", accessRole: "writer", summary: "Work" },
        ],
      },
    });
    m.freebusyQuery.mockResolvedValue({
      data: {
        calendars: {
          primary: { busy: [] },
          "work@group.calendar.google.com": {
            busy: [{ start: "2026-10-03T05:30:00Z", end: "2026-10-03T06:00:00Z" }],
          },
        },
      },
    });

    const result = (await checkConflicts("u1", START, END)) as {
      hasConflicts: boolean;
      conflicts: unknown[];
    };

    expect(result.hasConflicts).toBe(true);
    expect(result.conflicts).toEqual([
      { start: "2026-10-03T05:30:00Z", end: "2026-10-03T06:00:00Z", calendar: "Work" },
    ]);
  });

  it("lists an event once when a row and a free/busy block describe the same interval", async () => {
    m.calendarFindMany.mockResolvedValue([
      row({ id: "r1", startTime: "2026-10-03T05:30:00Z", endTime: "2026-10-03T06:00:00Z" }),
    ]);
    m.freebusyQuery.mockResolvedValue({
      data: {
        calendars: {
          primary: { busy: [{ start: "2026-10-03T05:30:00Z", end: "2026-10-03T06:00:00Z" }] },
        },
      },
    });

    const result = (await checkConflicts("u1", START, END)) as {
      conflicts: unknown[];
      message: string;
    };

    expect(result.conflicts).toHaveLength(1);
    expect(result.message).toBe("Found 1 conflicting event(s) in this time range.");
  });

  it("counts an invite in the primary and a linked calendar once, and marks a linked-only event read-only", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    m.calendarFindMany.mockResolvedValue([
      row({
        id: "l1",
        externalId: "g-invite",
        sourceAccountId: "acct-1",
        startTime: "2026-10-03T05:00:00Z",
        endTime: "2026-10-03T06:00:00Z",
      }),
      row({
        id: "p1",
        externalId: "g-invite",
        startTime: "2026-10-03T05:00:00Z",
        endTime: "2026-10-03T06:00:00Z",
      }),
      row({
        id: "l2",
        externalId: "g-other",
        sourceAccountId: "acct-1",
        startTime: "2026-10-03T05:30:00Z",
        endTime: "2026-10-03T05:45:00Z",
      }),
    ]);

    const result = (await checkConflicts("u1", START, END)) as {
      conflicts: Array<{ calendar: string; readOnly: boolean }>;
    };

    expect(result.conflicts.map((c) => [c.calendar, c.readOnly])).toEqual([
      ["primary", false],
      ["linked", true],
    ]);
  });

  it("says the slot is free when neither the rows nor Google see anything", async () => {
    const result = await checkConflicts("u1", START, END);

    expect(result).toMatchObject({
      hasConflicts: false,
      conflicts: [],
      message: "No conflicts — this time slot is free.",
    });
  });

  it("keeps main's answer when Google is not connected, and reads no row", async () => {
    m.getAuthedClient.mockResolvedValue(null);

    expect(await checkConflicts("u1", START, END)).toEqual({
      error: "Google Calendar not connected.",
    });
    expect(m.calendarFindMany).not.toHaveBeenCalled();
  });

  it("does not say a slot is free when the rows cannot be read, and the message names no database detail", async () => {
    m.calendarFindMany.mockRejectedValue(
      new Error("Can't reach database server at postgres://app:s3cret@db.internal:5432/klorn"),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const failure = await checkConflicts("u1", START, END).catch((err: Error) => err);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Could not read the synced calendar right now.");
    expect(String(failure)).not.toContain("s3cret");
    spy.mockRestore();
  });
});

describe("attendee free/busy stays live with the flag on", () => {
  beforeEach(enableUnified);

  it("still asks Google about the attendees and reads no row", async () => {
    m.freebusyQuery.mockResolvedValue({
      data: { calendars: { "bob@example.com": { busy: [{ start: "a", end: "b" }] } } },
    });

    const result = await checkAttendeeBusy("u1", ["bob@example.com"], START, END);

    expect(m.freebusyQuery).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ email: "bob@example.com", busy: true }]);
    expect(m.calendarFindMany).not.toHaveBeenCalled();
  });
});

describe("tool descriptions state the freshness trade-off only while the flag is on", () => {
  it("mentions the synced copy and the 15 minute refresh for list_events and the conflict check", () => {
    enableUnified();

    expect(toolDescription("list_events")).toContain("synced copy");
    expect(toolDescription("list_events")).toContain("15 minutes");
    expect(toolDescription("check_calendar_conflicts")).toContain("15 minutes");
    expect(toolDescription("check_calendar_conflicts")).toContain("free/busy");
  });

  it("says a deleted or cancelled event can still be listed until the sync removes it, not only that changes lag", () => {
    enableUnified();

    for (const name of ["list_events", "check_calendar_conflicts"]) {
      expect(toolDescription(name)).toMatch(/deleted or cancelled/);
      expect(toolDescription(name)).toMatch(/until Klorn's sync removes it/);
    }
  });

  it("turns back into the original text when the flag goes off again (read at request time)", () => {
    enableUnified();
    expect(toolDescription("list_events")).toContain("15 minutes");
    delete process.env.UNIFIED_CALENDAR_READ_ENABLED;
    expect(toolDescription("list_events")).toBe(
      "List upcoming events from the user's Google Calendar",
    );
  });

  it("survives JSON serialisation, which is how a tool definition reaches the model", () => {
    enableUnified();
    const tool = CALENDAR_TOOLS.find((t) => t.function.name === "list_events");
    const sent = JSON.parse(JSON.stringify(tool)) as { function: { description: string } };
    expect(sent.function.description).toContain("15 minutes");
  });
});

describe("the primary-only free/busy fallback (a 403) names no event, flag off or on", () => {
  const items = [
    {
      id: "timed",
      summary: "Layoff planning",
      start: { dateTime: "2026-10-03T14:00:00+09:00" },
      end: { dateTime: "2026-10-03T15:00:00+09:00" },
    },
  ];

  it.each([
    ["off", false],
    ["on", true],
  ])("flag %s: the conflict carries an id and an interval, never the title", async (_name, on) => {
    if (on) enableUnified();
    m.calendarListList.mockRejectedValue({ response: { status: 403 } });
    m.eventsList.mockResolvedValue({ data: { items } });

    const result = (await checkConflicts("u1", START, END)) as {
      hasConflicts: boolean;
      scope: string;
      conflicts: unknown[];
    };

    expect(result).toMatchObject({ hasConflicts: true, scope: "primary_only" });
    expect(result.conflicts).toEqual([
      { id: "timed", start: "2026-10-03T14:00:00+09:00", end: "2026-10-03T15:00:00+09:00" },
    ]);
    expect(JSON.stringify(result)).not.toContain("Layoff planning");
  });
});
