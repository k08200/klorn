/**
 * create_event conflict enforcement (#743).
 *
 * check_calendar_conflicts already existed as a genuine multi-calendar
 * checker, but it was only ever a separate, optional tool the model could
 * choose to call before create_event — nothing forced the sequencing, so a
 * customer's booking agent double-booked her calendar (it never called the
 * checker). This locks down that create_event cannot complete without
 * consulting checkConflicts, and that a detected conflict blocks the booking
 * instead of silently going through.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createEventMock = vi.fn();
const checkConflictsMock = vi.fn();
const calendarEventFindFirst = vi.fn();
const calendarEventCreate = vi.fn();

vi.mock("../db.js", () => ({
  prisma: {
    calendarEvent: { findFirst: calendarEventFindFirst, create: calendarEventCreate },
  },
  db: {},
}));
vi.mock("../mail/gmail.js", () => ({
  GMAIL_TOOLS: [],
  sendEmail: vi.fn(),
  listEmails: vi.fn(),
  readEmail: vi.fn(),
  markAsRead: vi.fn(),
  classifyEmails: vi.fn(),
}));
vi.mock("../pim/calendar.js", () => ({
  CALENDAR_TOOLS: [],
  createEvent: (...args: unknown[]) => createEventMock(...args),
  deleteEvent: vi.fn(),
  listEvents: vi.fn(),
  checkConflicts: (...args: unknown[]) => checkConflictsMock(...args),
}));
vi.mock("../pim/meeting.js", () => ({
  MEETING_TOOLS: [],
  getUpcomingMeetings: vi.fn(),
  joinMeeting: vi.fn(),
  summarizeMeeting: vi.fn(),
}));
vi.mock("../pim/briefing.js", () => ({ BRIEFING_TOOLS: [] }));
vi.mock("../learning/memory.js", () => ({
  MEMORY_TOOLS: [],
  forget: vi.fn(),
  recall: vi.fn(),
  remember: vi.fn(),
}));
vi.mock("../agentcore/skill-executor.js", () => ({
  SKILL_TOOLS: [],
  executeSkill: vi.fn(),
  listUserSkills: vi.fn(),
}));
vi.mock("../agentcore/skill-recorder.js", () => ({ recordSkill: vi.fn() }));
vi.mock("../judge/attention-mirror.js", () => ({
  upsertAttentionForCalendarEvent: vi.fn(),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../agentcore/agent-mode.js", () => ({ AGENT_MODES: [] }));
vi.mock("../billing/stripe.js", () => ({
  planHasFeature: () => true,
  TOOL_FEATURE_MAP: {},
}));
vi.mock("../agentcore/tool-result-budget.js", () => ({
  capToolResult: (s: string) => s,
}));
vi.mock("../untrusted.js", () => ({
  wrapUntrusted: (s: string) => s,
}));
vi.mock("../utilities.js", () => ({
  UTILITY_TOOLS: [],
  calculate: vi.fn(),
  convertCurrency: vi.fn(),
  generatePassword: vi.fn(),
  shortenUrl: vi.fn(),
  translate: vi.fn(),
}));

const { executeToolCall } = await import("../agentcore/tool-executor.js");

const userId = "user-1";
const args = {
  summary: "Piano lesson",
  start_time: "2026-08-01T10:00:00+09:00",
  end_time: "2026-08-01T11:00:00+09:00",
};

beforeEach(() => {
  vi.clearAllMocks();
  calendarEventFindFirst.mockResolvedValue(null); // no ±30min dup by default
  checkConflictsMock.mockResolvedValue({
    hasConflicts: false,
    conflicts: [],
    scope: "all_calendars",
    linkedAccountsChecked: 0,
    message: "No conflicts — this time slot is free.",
  });
  createEventMock.mockResolvedValue({ eventId: "g-event-1" });
  calendarEventCreate.mockResolvedValue({ id: "local-1" });
});

describe("create_event — conflict enforcement (#743)", () => {
  it("checks for conflicts before creating the event", async () => {
    await executeToolCall(userId, "create_event", args);
    expect(checkConflictsMock).toHaveBeenCalledWith(userId, args.start_time, args.end_time);
    expect(createEventMock).toHaveBeenCalled();
  });

  it("refuses to book when checkConflicts reports a genuine conflict — the customer-reported bug", async () => {
    checkConflictsMock.mockResolvedValue({
      hasConflicts: true,
      conflicts: [{ summary: "Existing lesson", start: args.start_time, end: args.end_time }],
      scope: "all_calendars",
      linkedAccountsChecked: 1,
      message: "Found 1 conflicting event(s) in this time range.",
    });

    const result = JSON.parse(await executeToolCall(userId, "create_event", args));

    expect(createEventMock).not.toHaveBeenCalled();
    expect(calendarEventCreate).not.toHaveBeenCalled();
    expect(result.skipped).toBe(true);
    expect(result.conflicts).toHaveLength(1);
  });

  it("echoes no title of a linked (work) calendar's event, but leaves a primary event's as it was", async () => {
    checkConflictsMock.mockResolvedValue({
      hasConflicts: true,
      conflicts: [
        {
          start: args.start_time,
          end: args.end_time,
          calendar: "linked",
          summary: "Layoff planning",
          provider: "GOOGLE",
          readOnly: true,
        },
        { id: "p1", summary: "Existing lesson", start: args.start_time, end: args.end_time },
      ],
      scope: "all_calendars",
      linkedAccountsChecked: 1,
      message: "Found 2 conflicting event(s) in this time range.",
    });

    const result = JSON.parse(await executeToolCall(userId, "create_event", args));

    expect(JSON.stringify(result)).not.toContain("Layoff planning");
    expect(result.conflicts[0]).toMatchObject({ calendar: "linked", readOnly: true });
    expect(result.conflicts[1].summary).toBe("Existing lesson");
  });

  it("books normally when the checker finds no conflicts", async () => {
    const result = JSON.parse(await executeToolCall(userId, "create_event", args));
    expect(createEventMock).toHaveBeenCalled();
    expect(result.eventId).toBe("g-event-1");
  });

  it("fails open (still books) when checkConflicts itself errors out, e.g. Google not connected", async () => {
    checkConflictsMock.mockResolvedValue({ error: "Google Calendar not connected." });
    await executeToolCall(userId, "create_event", args);
    expect(createEventMock).toHaveBeenCalled();
  });

  it("C1 dual-write: a booked Google event is stored as GOOGLE with externalId = its Google id", async () => {
    await executeToolCall(userId, "create_event", args);
    const data = (calendarEventCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      googleId: "g-event-1",
      provider: "GOOGLE",
      externalId: "g-event-1",
      sourceAccountId: null,
    });
  });

  it("C1 dual-write: a success result with no event id is stored as LOCAL with no externalId", async () => {
    createEventMock.mockResolvedValue({ success: true });
    await executeToolCall(userId, "create_event", args);
    const data = (calendarEventCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      googleId: null,
      provider: "LOCAL",
      externalId: null,
      sourceAccountId: null,
    });
  });

  it("still checks the ±30min local dedup before the conflict check, and skips the Google round-trip on a dup", async () => {
    calendarEventFindFirst.mockResolvedValue({
      id: "dup-1",
      title: "Piano lesson",
      startTime: new Date(args.start_time),
    });
    const result = JSON.parse(await executeToolCall(userId, "create_event", args));
    expect(result.skipped).toBe(true);
    expect(result.existingEventId).toBe("dup-1");
    expect(checkConflictsMock).not.toHaveBeenCalled();
    expect(createEventMock).not.toHaveBeenCalled();
  });
});

describe("create_event — the ±30 min duplicate check and linked calendars (C2)", () => {
  const dupWhere = () =>
    (calendarEventFindFirst.mock.calls.at(-1)?.[0] as { where: Record<string, unknown> }).where;

  /** A database holding one linked-calendar event in the slot, honouring the query's source filter. */
  function slotHoldsOnly(row: { id: string; title: string; sourceAccountId: string | null }) {
    calendarEventFindFirst.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) =>
        where.sourceAccountId !== null || row.sourceAccountId === null
          ? { ...row, startTime: new Date("2026-08-01T10:10:00+09:00") }
          : null,
    );
  }

  afterEach(() => {
    delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
  });

  it.each([
    ["off", undefined],
    ["on", "true"],
  ])("looks at primary and LOCAL rows only, flag %s: a linked row is read-only, so it is no duplicate to point at", async (_label, flag) => {
    if (flag === undefined) delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
    else process.env.LINKED_CALENDAR_SYNC_ENABLED = flag;

    await executeToolCall(userId, "create_event", args);

    expect(dupWhere().sourceAccountId).toBeNull();
  });

  it("does not return a linked calendar's event id as the existing duplicate (flag on)", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    slotHoldsOnly({ id: "linked-ev", title: "Work standup", sourceAccountId: "acct-1" });

    const result = JSON.parse(await executeToolCall(userId, "create_event", args));

    expect(result.existingEventId).toBeUndefined();
    expect(result.skipped).not.toBe(true);
    // The real double-book check still runs, and it covers linked calendars.
    expect(checkConflictsMock).toHaveBeenCalled();
    expect(createEventMock).toHaveBeenCalled();
  });

  it("still refuses a duplicate that is a primary event, pointing at it (flag on)", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    slotHoldsOnly({ id: "primary-ev", title: "Piano lesson", sourceAccountId: null });

    const result = JSON.parse(await executeToolCall(userId, "create_event", args));

    expect(result.skipped).toBe(true);
    expect(result.existingEventId).toBe("primary-ev");
    expect(createEventMock).not.toHaveBeenCalled();
  });

  it("a linked calendar's conflict still refuses the booking through the conflict check, not the duplicate check", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    checkConflictsMock.mockResolvedValue({
      hasConflicts: true,
      conflicts: [{ start: args.start_time, end: args.end_time, calendar: "primary" }],
      scope: "all_calendars",
      linkedAccountsChecked: 1,
      message: "Found 1 conflicting event(s) in this time range.",
    });

    const result = JSON.parse(await executeToolCall(userId, "create_event", args));

    expect(result.skipped).toBe(true);
    expect(createEventMock).not.toHaveBeenCalled();
  });
});
