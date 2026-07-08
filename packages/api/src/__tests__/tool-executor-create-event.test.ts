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

import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("../gmail.js", () => ({
  GMAIL_TOOLS: [],
  sendEmail: vi.fn(),
  listEmails: vi.fn(),
  readEmail: vi.fn(),
  markAsRead: vi.fn(),
  classifyEmails: vi.fn(),
}));
vi.mock("../calendar.js", () => ({
  CALENDAR_TOOLS: [],
  createEvent: (...args: unknown[]) => createEventMock(...args),
  deleteEvent: vi.fn(),
  listEvents: vi.fn(),
  checkConflicts: (...args: unknown[]) => checkConflictsMock(...args),
}));
vi.mock("../meeting.js", () => ({
  MEETING_TOOLS: [],
  getUpcomingMeetings: vi.fn(),
  joinMeeting: vi.fn(),
  summarizeMeeting: vi.fn(),
}));
vi.mock("../briefing.js", () => ({ BRIEFING_TOOLS: [] }));
vi.mock("../memory.js", () => ({
  MEMORY_TOOLS: [],
  forget: vi.fn(),
  recall: vi.fn(),
  remember: vi.fn(),
}));
vi.mock("../search.js", () => ({ SEARCH_TOOLS: [], webSearch: vi.fn() }));
vi.mock("../skill-executor.js", () => ({
  SKILL_TOOLS: [],
  executeSkill: vi.fn(),
  listUserSkills: vi.fn(),
}));
vi.mock("../skill-recorder.js", () => ({ recordSkill: vi.fn() }));
vi.mock("../attention-mirror.js", () => ({
  upsertAttentionForCalendarEvent: vi.fn(),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../agent-mode.js", () => ({ AGENT_MODES: [] }));
vi.mock("../stripe.js", () => ({
  planHasFeature: () => true,
  TOOL_FEATURE_MAP: {},
}));
vi.mock("../tool-result-budget.js", () => ({
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

const { executeToolCall } = await import("../tool-executor.js");

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
