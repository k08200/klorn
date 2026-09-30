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
  markLinkedCalendarForReconnect: vi.fn(async () => {}),
  linkedFindMany: vi.fn(async () => [] as unknown[]),
  linkedFindFirst: vi.fn(async () => null),
  // The linked accounts the seam lists, and the client each one resolves to.
  linkedRows: [] as Array<{
    id: string;
    email: string;
    provider: string;
    needsReconnect: boolean;
    client: unknown;
  }>,
}));
const {
  calendarListMock,
  freebusyMock,
  eventsListMock,
  markGoogleTokenForReconnect,
  captureError,
  markLinkedCalendarForReconnect,
} = m;

function setLinkedAccounts(
  accounts: Array<{ id?: string; email: string; client?: unknown; needsReconnect?: boolean }>,
) {
  m.linkedRows = accounts.map((a, i) => ({
    id: a.id ?? `acct-${i + 1}`,
    email: a.email,
    provider: "GOOGLE",
    needsReconnect: a.needsReconnect ?? false,
    client: a.client ?? {},
  }));
  m.linkedFindMany.mockResolvedValue(m.linkedRows);
}

vi.mock("googleapis", () => ({
  google: {
    calendar: vi.fn(() => ({
      calendarList: { list: m.calendarListMock },
      freebusy: { query: m.freebusyMock },
      events: { list: m.eventsListMock },
    })),
  },
}));

vi.mock("../mail/gmail.js", () => ({
  getAuthedClient: vi.fn(async () => ({})),
  // The dispatcher hands the listed row over; the fixture's `client` stands for the decrypted token.
  buildLinkedCalendarClient: (
    _userId: string,
    row: { id: string; email: string; client: unknown },
  ) => ({
    client: row.client,
    id: row.id,
    email: row.email,
  }),
  isGoogleAuthError: (e: { response?: { status?: number } }) => e?.response?.status === 401,
  markGoogleTokenForReconnect: m.markGoogleTokenForReconnect,
  markLinkedCalendarForReconnect: m.markLinkedCalendarForReconnect,
}));

vi.mock("../db.js", () => ({
  prisma: {
    automationConfig: { findUnique: vi.fn(async () => ({ timezone: "Asia/Seoul" })) },
    linkedCalendarAccount: {
      findMany: m.linkedFindMany,
      findFirst: m.linkedFindFirst,
    },
  },
}));

vi.mock("../sentry.js", () => ({ captureError: m.captureError }));

import { checkConflicts } from "../pim/calendar.js";

const START = "2026-06-03T14:00:00+09:00"; // 05:00Z
const END = "2026-06-03T15:00:00+09:00"; // 06:00Z

describe("checkConflicts — multi-calendar free/busy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.linkedRows = []; // default: no linked accounts
    m.linkedFindMany.mockResolvedValue([]);
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
    setLinkedAccounts([{ email: "me@work.com" }]);
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
    setLinkedAccounts([{ email: "me@work.com" }]);
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

  it("a revoked linked account flags it for reconnect, is never sent to Sentry, and does not sink the check (C2)", async () => {
    setLinkedAccounts([{ id: "acct-work", email: "me@work.com" }]);
    calendarListMock
      .mockResolvedValueOnce({
        data: { items: [{ id: "primary", primary: true, accessRole: "owner", summary: "me" }] },
      })
      .mockRejectedValueOnce({ response: { status: 401 }, message: "invalid_grant" });
    freebusyMock.mockResolvedValueOnce({ data: { calendars: { primary: { busy: [] } } } });

    const result = await checkConflicts("user-1", START, END);

    expect(result).toMatchObject({ hasConflicts: false, linkedAccountsChecked: 1 });
    expect(markLinkedCalendarForReconnect).toHaveBeenCalledWith("user-1", "acct-work");
    expect(captureError).not.toHaveBeenCalled();
  });

  it("still checks an account flagged needsReconnect: a successful refresh clears the flag (C2)", async () => {
    setLinkedAccounts([{ email: "me@work.com", needsReconnect: true }]);
    calendarListMock.mockResolvedValue({
      data: { items: [{ id: "primary", primary: true, accessRole: "owner", summary: "me" }] },
    });
    freebusyMock.mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } });

    const result = await checkConflicts("user-1", START, END);

    expect(result).toMatchObject({ linkedAccountsChecked: 1 });
    expect(calendarListMock).toHaveBeenCalledTimes(2);
  });

  it("an account of a provider with no calendar implementation yet is skipped, not counted (C2)", async () => {
    setLinkedAccounts([{ email: "me@work.com" }]);
    m.linkedRows = m.linkedRows.map((r) => ({ ...r, provider: "OUTLOOK" }));
    m.linkedFindMany.mockResolvedValue(m.linkedRows);
    calendarListMock.mockResolvedValue({
      data: { items: [{ id: "primary", primary: true, accessRole: "owner", summary: "me" }] },
    });
    freebusyMock.mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } });

    const result = await checkConflicts("user-1", START, END);

    expect(result).toMatchObject({ linkedAccountsChecked: 0 });
    expect(calendarListMock).toHaveBeenCalledTimes(1);
  });

  it("a conflict check reads the linked accounts once, however many there are, and looks nothing else up (C2)", async () => {
    setLinkedAccounts([
      { email: "a@work.com" },
      { email: "b@school.edu" },
      { email: "c@side.org" },
    ]);
    calendarListMock.mockResolvedValue({
      data: { items: [{ id: "primary", primary: true, accessRole: "owner", summary: "me" }] },
    });
    freebusyMock.mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } });

    const result = await checkConflicts("user-1", START, END);

    expect(result).toMatchObject({ linkedAccountsChecked: 3 });
    // What main paid: one read of the linked rows. Nothing per account.
    expect(m.linkedFindMany).toHaveBeenCalledTimes(1);
    expect(m.linkedFindFirst).not.toHaveBeenCalled();
  });
});
