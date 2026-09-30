/**
 * C7 through the real registry and executor: the chat and the MCP endpoint both
 * reach `list_events` / `check_calendar_conflicts` via executeToolCall, and the
 * MCP ListTools reads the definition's description at request time. With
 * UNIFIED_CALENDAR_READ_ENABLED on they read rows (and say so); off, they call Google.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  eventsList: vi.fn(),
  freebusyQuery: vi.fn(),
  calendarListList: vi.fn(),
  calendarFindMany: vi.fn(),
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
vi.mock("../mail/gmail.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mail/gmail.js")>()),
  getAuthedClient: vi.fn(async () => ({ tag: "primary" })),
}));
vi.mock("../db.js", () => {
  const prisma = {
    calendarEvent: { findMany: m.calendarFindMany, count: vi.fn(async () => 0) },
    automationConfig: { findUnique: vi.fn(async () => ({ timezone: "Asia/Seoul" })) },
    linkedCalendarAccount: { findMany: vi.fn(async () => []) },
  };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { executeToolCall } from "../agentcore/tool-executor.js";
import { mcpToolDefs } from "../mcp/tool-gate.js";

const ROW = {
  id: "r1",
  title: "Board",
  description: null,
  location: null,
  startTime: new Date("2026-10-03T05:30:00Z"),
  endTime: new Date("2026-10-03T06:30:00Z"),
  allDay: false,
  provider: "GOOGLE",
  externalId: "g-r1",
  sourceAccountId: null,
};

function mcpDescription(name: string): string | undefined {
  return mcpToolDefs("PRO", "read").find((t) => t.function.name === name)?.function.description;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.calendarFindMany.mockResolvedValue([ROW]);
  m.eventsList.mockResolvedValue({ data: { items: [] } });
  m.calendarListList.mockResolvedValue({
    data: { items: [{ id: "primary", primary: true, accessRole: "owner", summary: "me" }] },
  });
  m.freebusyQuery.mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } });
});
afterEach(() => {
  delete process.env.UNIFIED_CALENDAR_READ_ENABLED;
});

describe("list_events through executeToolCall (chat and MCP)", () => {
  it("flag off: asks Google, reads no row", async () => {
    await executeToolCall("u1", "list_events", { max_results: 3 });

    expect(m.eventsList).toHaveBeenCalledTimes(1);
    expect(m.calendarFindMany).not.toHaveBeenCalled();
  });

  it("flag on: answers from rows, with provider and readOnly, and does not call Google", async () => {
    process.env.UNIFIED_CALENDAR_READ_ENABLED = "true";

    const result = JSON.parse(await executeToolCall("u1", "list_events", { max_results: 3 })) as {
      events: Array<Record<string, unknown>>;
    };

    expect(m.eventsList).not.toHaveBeenCalled();
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ id: "g-r1", provider: "GOOGLE", readOnly: false });
  });
});

describe("check_calendar_conflicts through executeToolCall", () => {
  const args = {
    start_time: "2026-10-03T14:00:00+09:00",
    end_time: "2026-10-03T15:00:00+09:00",
  };

  it("flag off: free/busy only", async () => {
    const result = JSON.parse(await executeToolCall("u1", "check_calendar_conflicts", args));

    expect(result.hasConflicts).toBe(false);
    expect(m.calendarFindMany).not.toHaveBeenCalled();
  });

  it("flag on: a row inside the window is a conflict, and free/busy is asked as well", async () => {
    process.env.UNIFIED_CALENDAR_READ_ENABLED = "true";

    const result = JSON.parse(await executeToolCall("u1", "check_calendar_conflicts", args));

    expect(result.hasConflicts).toBe(true);
    expect(result.conflicts[0]).toMatchObject({ provider: "GOOGLE", readOnly: false });
    expect(m.freebusyQuery).toHaveBeenCalledTimes(1);
  });
});

describe("the MCP tool list states the freshness trade-off only while the flag is on", () => {
  it("is the original description with the flag off", () => {
    expect(mcpDescription("list_events")).toBe(
      "List upcoming events from the user's Google Calendar",
    );
  });

  it("names the synced copy and the 15 minute refresh with the flag on, read at request time", () => {
    process.env.UNIFIED_CALENDAR_READ_ENABLED = "true";

    expect(mcpDescription("list_events")).toContain("15 minutes");
    expect(mcpDescription("check_calendar_conflicts")).toContain("free/busy");
  });
});
