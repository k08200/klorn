import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * checkConflicts must catch a double-book on ANY calendar the user writes to,
 * not just primary — that was the real-user miss. It uses freebusy.query across
 * every owner/writer calendar (needs the calendar.readonly scope), and degrades
 * to a primary-only events.list when an existing token lacks that scope (403).
 */

const m = vi.hoisted(() => ({
  calendarListMock: vi.fn(),
  freebusyMock: vi.fn(),
  eventsListMock: vi.fn(),
  markGoogleTokenForReconnect: vi.fn(async () => {}),
  captureError: vi.fn(),
  linkedClientsMock: vi.fn(async () => [] as Array<{ client: unknown; email: string }>),
}));
const {
  calendarListMock,
  freebusyMock,
  eventsListMock,
  markGoogleTokenForReconnect,
  captureError,
  linkedClientsMock,
} = m;

vi.mock("googleapis", () => ({
  google: {
    calendar: vi.fn(() => ({
      calendarList: { list: m.calendarListMock },
      freebusy: { query: m.freebusyMock },
      events: { list: m.eventsListMock },
    })),
  },
}));

vi.mock("../gmail.js", () => ({
  getAuthedClient: vi.fn(async () => ({})),
  getLinkedCalendarClients: m.linkedClientsMock,
  isGoogleAuthError: (e: { response?: { status?: number } }) => e?.response?.status === 401,
  markGoogleTokenForReconnect: m.markGoogleTokenForReconnect,
}));

vi.mock("../db.js", () => ({
  prisma: {
    automationConfig: { findUnique: vi.fn(async () => ({ timezone: "Asia/Seoul" })) },
  },
}));

vi.mock("../sentry.js", () => ({ captureError: m.captureError }));

import { checkConflicts } from "../pim/calendar.js";

const START = "2026-06-03T14:00:00+09:00"; // 05:00Z
const END = "2026-06-03T15:00:00+09:00"; // 06:00Z

describe("checkConflicts — multi-calendar free/busy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    linkedClientsMock.mockResolvedValue([]); // default: no linked accounts
  });

  it("queries free/busy across owner+writer calendars (skips reader subs) and merges busy blocks", async () => {
    calendarListMock.mockResolvedValue({
      data: {
        items: [
          { id: "primary", primary: true, accessRole: "owner", summary: "alice@company.com" },
          { id: "work@group.calendar.google.com", accessRole: "writer", summary: "Work" },
          { id: "holidays@group.v.calendar.google.com", accessRole: "reader", summary: "Holidays" },
        ],
      },
    });
    freebusyMock.mockResolvedValue({
      data: {
        calendars: {
          primary: { busy: [] },
          "work@group.calendar.google.com": {
            busy: [{ start: "2026-06-03T05:30:00Z", end: "2026-06-03T06:00:00Z" }],
          },
        },
      },
    });

    const result = await checkConflicts("user-1", START, END);

    // reader calendar is excluded from the freebusy query
    const items = freebusyMock.mock.calls[0]?.[0]?.requestBody?.items;
    expect(items).toEqual([{ id: "primary" }, { id: "work@group.calendar.google.com" }]);
    // the window was normalized to an absolute instant
    expect(freebusyMock.mock.calls[0]?.[0]?.requestBody?.timeMin).toBe("2026-06-03T05:00:00.000Z");

    expect(result).toMatchObject({ hasConflicts: true, scope: "all_calendars" });
    // tagged with the display-name label, NOT the raw calendar id
    expect(result.conflicts).toEqual([
      { start: "2026-06-03T05:30:00Z", end: "2026-06-03T06:00:00Z", calendar: "Work" },
    ]);
    expect(eventsListMock).not.toHaveBeenCalled();
  });

  it("surfaces a partial free/busy result (a calendar errored) instead of silently treating it as free", async () => {
    calendarListMock.mockResolvedValue({
      data: {
        items: [
          { id: "primary", primary: true, accessRole: "owner", summary: "me@company.com" },
          { id: "revoked@group.calendar.google.com", accessRole: "writer", summary: "Revoked" },
        ],
      },
    });
    freebusyMock.mockResolvedValue({
      data: {
        calendars: {
          primary: { busy: [] },
          "revoked@group.calendar.google.com": { errors: [{ reason: "notFound" }], busy: [] },
        },
      },
    });

    const result = await checkConflicts("user-1", START, END);

    // we still return what we could read, but the failure is captured, not silent
    expect(result).toMatchObject({ scope: "all_calendars" });
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError.mock.calls[0]?.[1]?.tags?.scope).toBe("calendar.freebusy_partial");
  });

  it("reports no conflicts when every calendar is free", async () => {
    calendarListMock.mockResolvedValue({
      data: { items: [{ id: "primary", primary: true, accessRole: "owner" }] },
    });
    freebusyMock.mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } });

    const result = await checkConflicts("user-1", START, END);
    expect(result).toMatchObject({ hasConflicts: false, scope: "all_calendars" });
    expect(result.conflicts).toEqual([]);
  });

  it("falls back to primary-only events.list when the token lacks calendar.readonly (403)", async () => {
    calendarListMock.mockRejectedValue({ response: { status: 403 } });
    eventsListMock.mockResolvedValue({
      data: {
        items: [
          // all-day marker must NOT count as a conflict
          { id: "allday", summary: "Holiday", start: { date: "2026-06-03" } },
          {
            id: "timed",
            summary: "1:1",
            start: { dateTime: "2026-06-03T14:00:00+09:00" },
            end: { dateTime: "2026-06-03T15:00:00+09:00" },
          },
        ],
      },
    });

    const result = await checkConflicts("user-1", START, END);

    expect(result).toMatchObject({ hasConflicts: true, scope: "primary_only" });
    expect(result.conflicts).toEqual([
      {
        id: "timed",
        summary: "1:1",
        start: "2026-06-03T14:00:00+09:00",
        end: "2026-06-03T15:00:00+09:00",
      },
    ]);
    expect(freebusyMock).not.toHaveBeenCalled();
    expect(eventsListMock).toHaveBeenCalledOnce();
  });

  it("returns a reconnect error on an auth failure (401)", async () => {
    calendarListMock.mockRejectedValue({ response: { status: 401 } });
    const result = await checkConflicts("user-1", START, END);
    expect(result).toMatchObject({ error: expect.stringContaining("reconnect") });
    expect(markGoogleTokenForReconnect).toHaveBeenCalledWith("user-1");
  });

  it("rejects an unparseable time range before any API call", async () => {
    const result = await checkConflicts("user-1", "not-a-date", END);
    expect(result).toMatchObject({ error: expect.stringContaining("Invalid time range") });
    expect(calendarListMock).not.toHaveBeenCalled();
  });

  it("merges a busy block from a LINKED (work) account across a separate Google account", async () => {
    // The real cross-account fix: the work calendar lives on a different Google
    // account, so the primary token can't see it — a linked account can.
    linkedClientsMock.mockResolvedValue([{ client: {}, email: "me@work.com" }]);
    // Call sequence: primary calendarList → primary freebusy → work calendarList → work freebusy.
    calendarListMock
      .mockResolvedValueOnce({
        data: {
          items: [
            { id: "primary", primary: true, accessRole: "owner", summary: "me@personal.com" },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [{ id: "primary", primary: true, accessRole: "owner", summary: "me@work.com" }],
        },
      });
    freebusyMock
      .mockResolvedValueOnce({ data: { calendars: { primary: { busy: [] } } } }) // personal: free
      .mockResolvedValueOnce({
        data: {
          calendars: {
            primary: { busy: [{ start: "2026-06-03T05:30:00Z", end: "2026-06-03T06:00:00Z" }] },
          },
        },
      }); // work: busy

    const result = await checkConflicts("user-1", START, END);

    expect(result).toMatchObject({
      hasConflicts: true,
      scope: "all_calendars",
      linkedAccountsChecked: 1,
    });
    expect(result.conflicts).toEqual([
      { start: "2026-06-03T05:30:00Z", end: "2026-06-03T06:00:00Z", calendar: "primary" },
    ]);
  });

  it("does not let a failing linked account sink the check (best-effort + capture)", async () => {
    linkedClientsMock.mockResolvedValue([{ client: {}, email: "me@work.com" }]);
    calendarListMock
      .mockResolvedValueOnce({
        data: {
          items: [
            { id: "primary", primary: true, accessRole: "owner", summary: "me@personal.com" },
          ],
        },
      })
      .mockRejectedValueOnce(new Error("work account boom")); // linked calendarList fails
    freebusyMock.mockResolvedValueOnce({
      data: {
        calendars: {
          primary: { busy: [{ start: "2026-06-03T05:30:00Z", end: "2026-06-03T06:00:00Z" }] },
        },
      },
    });

    const result = await checkConflicts("user-1", START, END);

    // primary conflict still returned; linked failure captured, not thrown
    expect(result).toMatchObject({
      hasConflicts: true,
      scope: "all_calendars",
      linkedAccountsChecked: 1,
    });
    expect(result.conflicts).toHaveLength(1);
    expect(
      captureError.mock.calls.some(
        (c) =>
          (c[1] as { tags?: { scope?: string } })?.tags?.scope ===
          "calendar.linked_freebusy_failed",
      ),
    ).toBe(true);
  });
});
