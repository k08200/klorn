/**
 * C2: each linked GOOGLE calendar account is synced into CalendarEvent rows
 * (provider GOOGLE, externalId = the event id, sourceAccountId = the linked
 * account), with the same window and caps as the primary sync. The scheduler
 * wiring and the flag are covered in automation-scheduler-calendar-sync.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  eventsList: vi.fn(),
  cancelledList: vi.fn(),
  googleCalendar: vi.fn(),
  linkedRows: [] as Array<{
    id: string;
    email: string;
    provider: string;
    needsReconnect: boolean;
    client: unknown;
  }>,
  markLinkedCalendarForReconnect: vi.fn(async () => {}),
  isGoogleAuthError: vi.fn((e: { response?: { status?: number } }) => e?.response?.status === 401),
  userFindUnique: vi.fn(),
  eventUpsert: vi.fn(async () => ({})),
  captureError: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    calendar: m.googleCalendar.mockImplementation(() => ({
      // The cancellation scan (C2b) is a second events.list; it gets its own mock so
      // every assertion on `eventsList` below stays about the sync's own listing.
      events: {
        list: (args: { showDeleted?: boolean }) =>
          args.showDeleted
            ? (m.cancelledList(args) ?? { data: { items: [] } })
            : m.eventsList(args),
      },
    })),
  },
}));
vi.mock("../mail/gmail.js", () => ({
  getAuthedClient: vi.fn(async () => ({})),
  buildLinkedCalendarClient: (
    _userId: string,
    row: { id: string; email: string; client: unknown },
  ) => ({
    client: row.client,
    id: row.id,
    email: row.email,
  }),
  isGoogleAuthError: m.isGoogleAuthError,
  markLinkedCalendarForReconnect: m.markLinkedCalendarForReconnect,
}));
vi.mock("../db.js", () => {
  const prisma = {
    user: { findUnique: m.userFindUnique },
    calendarEvent: { upsert: m.eventUpsert },
    linkedCalendarAccount: {
      findMany: vi.fn(async () => m.linkedRows),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: m.captureError }));

import { linkedCalendarSyncEnabled } from "../config.js";
import { syncLinkedCalendars } from "../pim/calendar-sync.js";
import { _resetLinkedCalendarFailureLogForTests } from "../pim/linked-calendar-failure.js";

const NOW = new Date("2026-09-30T05:00:00.000Z");
const WORK = { client: { tag: "work-client" }, id: "acct-work", email: "me@work.com" };
const SCHOOL = { client: { tag: "school-client" }, id: "acct-school", email: "me@school.edu" };

type LinkedFixture = typeof WORK & { needsReconnect?: boolean; provider?: string };
function setLinked(accounts: LinkedFixture[]) {
  m.linkedRows = accounts.map((a) => ({
    id: a.id,
    email: a.email,
    provider: a.provider ?? "GOOGLE",
    needsReconnect: a.needsReconnect ?? false,
    client: a.client,
  }));
}

function timed(id: string, title = "Planning") {
  return {
    id,
    summary: title,
    start: { dateTime: "2026-10-02T09:00:00+09:00" },
    end: { dateTime: "2026-10-02T10:00:00+09:00" },
  };
}

type UpsertArg = {
  where: { userId_provider_sourceKey_externalId: Record<string, string> };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
};
function upserts(): UpsertArg[] {
  return m.eventUpsert.mock.calls.map((c) => (c as unknown[])[0] as UpsertArg);
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetLinkedCalendarFailureLogForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  setLinked([WORK]);
  m.userFindUnique.mockResolvedValue({ id: "u1", timezone: "Asia/Seoul" });
  m.eventsList.mockResolvedValue({ data: { items: [timed("g-1")] } });
});

describe("syncLinkedCalendars", () => {
  it("lists each linked account's primary calendar with that account's own client", async () => {
    setLinked([WORK, SCHOOL]);

    await syncLinkedCalendars("u1", NOW);

    expect(m.googleCalendar).toHaveBeenCalledWith({ version: "v3", auth: WORK.client });
    expect(m.googleCalendar).toHaveBeenCalledWith({ version: "v3", auth: SCHOOL.client });
    expect(m.eventsList).toHaveBeenCalledTimes(2);
  });

  it("uses the same window and caps as the primary sync: next 30 days, 100 events, the user's zone", async () => {
    await syncLinkedCalendars("u1", NOW);

    expect(m.eventsList).toHaveBeenCalledWith({
      calendarId: "primary",
      timeMin: "2026-09-30T05:00:00.000Z",
      timeMax: "2026-10-30T05:00:00.000Z",
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 100,
      timeZone: "Asia/Seoul",
    });
  });

  it("writes GOOGLE rows tagged with the account, keyed per source, with no googleId", async () => {
    await syncLinkedCalendars("u1", NOW);

    expect(upserts()).toHaveLength(1);
    const [row] = upserts();
    expect(row?.where).toEqual({
      userId_provider_sourceKey_externalId: {
        userId: "u1",
        provider: "GOOGLE",
        sourceKey: "acct-work",
        externalId: "g-1",
      },
    });
    expect(row?.create).toMatchObject({
      userId: "u1",
      provider: "GOOGLE",
      externalId: "g-1",
      sourceAccountId: "acct-work",
      sourceKey: "acct-work",
      title: "Planning",
      allDay: false,
    });
    expect(row?.create).not.toHaveProperty("googleId");
  });

  it("keeps one row per source when the same event id is in two linked calendars", async () => {
    setLinked([WORK, SCHOOL]);
    m.eventsList.mockResolvedValue({ data: { items: [timed("g-shared")] } });

    await syncLinkedCalendars("u1", NOW);

    const keys = upserts().map((u) => u.where.userId_provider_sourceKey_externalId);
    expect(keys.map((k) => k.sourceKey)).toEqual(["acct-work", "acct-school"]);
    expect(new Set(keys.map((k) => k.externalId))).toEqual(new Set(["g-shared"]));
  });

  it("reads a naive timed value in the user's timezone and skips events with no id or times", async () => {
    m.eventsList.mockResolvedValue({
      data: {
        items: [
          {
            id: "g-naive",
            summary: "Naive",
            start: { dateTime: "2026-10-02T09:00:00" },
            end: { dateTime: "2026-10-02T10:00:00" },
          },
          { summary: "no id", start: { date: "2026-10-05" }, end: { date: "2026-10-06" } },
          { id: "g-no-times", start: {}, end: {} },
        ],
      },
    });

    const result = await syncLinkedCalendars("u1", NOW);

    expect(upserts()).toHaveLength(1);
    expect(upserts()[0]?.create).toMatchObject({
      externalId: "g-naive",
      startTime: new Date("2026-10-02T00:00:00.000Z"),
      endTime: new Date("2026-10-02T01:00:00.000Z"),
    });
    expect(result).toEqual({ accounts: 1, events: 1, failedAccounts: 0 });
  });

  it("does nothing, and reads no user row, when the user has no linked calendars", async () => {
    setLinked([]);

    const result = await syncLinkedCalendars("u1", NOW);

    expect(result).toEqual({ accounts: 0, events: 0, failedAccounts: 0 });
    expect(m.userFindUnique).not.toHaveBeenCalled();
    expect(m.googleCalendar).not.toHaveBeenCalled();
  });

  it("a failing account is captured (domain only) and never sinks the others", async () => {
    setLinked([WORK, SCHOOL]);
    m.eventsList.mockRejectedValueOnce(new Error("work account boom"));
    m.eventsList.mockResolvedValueOnce({ data: { items: [timed("g-school")] } });

    const result = await syncLinkedCalendars("u1", NOW);

    expect(result).toEqual({ accounts: 2, events: 1, failedAccounts: 1 });
    expect(upserts().map((u) => u.create.sourceAccountId)).toEqual(["acct-school"]);
    expect(m.markLinkedCalendarForReconnect).not.toHaveBeenCalled();
    const captured = m.captureError.mock.calls[0]?.[1] as {
      tags: { scope: string };
      extra: Record<string, unknown>;
    };
    expect(captured.tags.scope).toBe("calendar.linked_sync_failed");
    expect(captured.extra).toMatchObject({ userId: "u1", accountDomain: "work.com" });
    expect(JSON.stringify(captured)).not.toContain("me@work.com");
  });

  it("flags an account whose token was revoked for reconnect, and keeps going", async () => {
    setLinked([WORK, SCHOOL]);
    m.eventsList.mockRejectedValueOnce({ response: { status: 401 } });
    m.eventsList.mockResolvedValueOnce({ data: { items: [timed("g-school")] } });

    const result = await syncLinkedCalendars("u1", NOW);

    expect(m.markLinkedCalendarForReconnect).toHaveBeenCalledWith("u1", "acct-work");
    expect(result.failedAccounts).toBe(1);
    expect(upserts()).toHaveLength(1);
    // A revoked token is the user's to fix: it must never page through Sentry.
    expect(m.captureError).not.toHaveBeenCalled();
  });

  it("warns about a revoked account once per window, not on every sync cycle (C2)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    m.eventsList.mockRejectedValue({ response: { status: 401 } });

    await syncLinkedCalendars("u1", NOW);
    await syncLinkedCalendars("u1", NOW);
    await syncLinkedCalendars("u1", NOW);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(m.captureError).not.toHaveBeenCalled();
  });

  it("leaves an account flagged needsReconnect alone until it is re-linked (C2)", async () => {
    setLinked([{ ...WORK, needsReconnect: true }, SCHOOL]);

    const result = await syncLinkedCalendars("u1", NOW);

    // One API object for the listing, one for the cancellation scan (C2b): both SCHOOL's.
    expect(m.googleCalendar).toHaveBeenCalledTimes(2);
    expect(m.googleCalendar).toHaveBeenCalledWith({ version: "v3", auth: SCHOOL.client });
    expect(m.googleCalendar).not.toHaveBeenCalledWith({ version: "v3", auth: WORK.client });
    expect(result).toEqual({ accounts: 1, events: 1, failedAccounts: 0 });
  });

  it("does nothing, and reads no user row, when every linked account needs a re-link (C2)", async () => {
    setLinked([{ ...WORK, needsReconnect: true }]);

    const result = await syncLinkedCalendars("u1", NOW);

    expect(result).toEqual({ accounts: 0, events: 0, failedAccounts: 0 });
    expect(m.userFindUnique).not.toHaveBeenCalled();
  });

  it("skips a linked account of a provider with no implementation yet (C2)", async () => {
    setLinked([{ ...WORK, provider: "OUTLOOK" }, SCHOOL]);

    const result = await syncLinkedCalendars("u1", NOW);

    expect(m.googleCalendar).toHaveBeenCalledTimes(2); // listing + cancellation scan, SCHOOL only
    expect(m.googleCalendar).not.toHaveBeenCalledWith({ version: "v3", auth: WORK.client });
    expect(result.accounts).toBe(1);
  });

  it("a failing reconnect flag does not abort the loop or hide the sync error", async () => {
    setLinked([WORK, SCHOOL]);
    m.eventsList.mockRejectedValueOnce({ response: { status: 401 } });
    m.eventsList.mockResolvedValueOnce({ data: { items: [timed("g-school")] } });
    m.markLinkedCalendarForReconnect.mockRejectedValueOnce(new Error("db blip"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await syncLinkedCalendars("u1", NOW);

    expect(result).toEqual({ accounts: 2, events: 1, failedAccounts: 1 });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("an account unlinked mid-sync (its rows hit the foreign key, P2003) is skipped quietly, not reported", async () => {
    m.eventUpsert.mockRejectedValueOnce({ code: "P2003" });

    const result = await syncLinkedCalendars("u1", NOW);

    expect(result).toEqual({ accounts: 1, events: 0, failedAccounts: 0 });
    expect(m.captureError).not.toHaveBeenCalled();
    expect(m.markLinkedCalendarForReconnect).not.toHaveBeenCalled();
  });

  it("a row write failure counts as that account failing, not as a crash", async () => {
    m.eventUpsert.mockRejectedValueOnce(new Error("db down"));

    const result = await syncLinkedCalendars("u1", NOW);

    expect(result).toEqual({ accounts: 1, events: 0, failedAccounts: 1 });
  });
});

describe("linkedCalendarSyncEnabled (LINKED_CALENDAR_SYNC_ENABLED)", () => {
  const KEY = "LINKED_CALENDAR_SYNC_ENABLED";
  const original = process.env[KEY];

  function withFlag(value: string | undefined): boolean {
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    try {
      return linkedCalendarSyncEnabled();
    } finally {
      if (original === undefined) delete process.env[KEY];
      else process.env[KEY] = original;
    }
  }

  it("is OFF when unset or empty", () => {
    expect(withFlag(undefined)).toBe(false);
    expect(withFlag("")).toBe(false);
    expect(withFlag("   ")).toBe(false);
  });

  it.each([
    "true",
    "TRUE",
    " True ",
    "1",
    "yes",
    "on",
    "ON",
  ])("reads %j as on (lenient parse)", (v) => {
    expect(withFlag(v)).toBe(true);
  });

  it.each(["false", "0", "no", "off", "2", "enabled", "truee"])("reads %j as off", (v) => {
    expect(withFlag(v)).toBe(false);
  });

  it("is read at request time: a flip needs no restart", () => {
    process.env[KEY] = "false";
    expect(linkedCalendarSyncEnabled()).toBe(false);
    process.env[KEY] = "true";
    expect(linkedCalendarSyncEnabled()).toBe(true);
    process.env[KEY] = "false";
    expect(linkedCalendarSyncEnabled()).toBe(false);
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });
});
