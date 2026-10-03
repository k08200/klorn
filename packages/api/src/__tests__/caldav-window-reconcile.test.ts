/**
 * C3: removing CalDAV rows whose events vanished. A CalDAV time-range query sees
 * the full current set of a window, so a row of that window the listing no longer
 * has was deleted or cancelled upstream: it is removed, with its attention items
 * resolved. Unlike Google (C2b), absence is the signal, so the guard is strict:
 *   - only after a COMPLETE listing (every calendar answered, nothing capped, cut
 *     short or unreadable);
 *   - only for ICLOUD and NAVER, only while CALDAV_CALENDAR_ENABLED is on;
 *   - only that account's rows (user, provider, source key), only rows inside the
 *     window, only rows written before the listing started.
 * Truncated and partial listings remove nothing.
 *
 * Review fixes (2026-10-02): a row of a calendar the discovery did not list is
 * unknown, never removed (a calendar missing from one PROPFIND is not an empty
 * calendar); a removal of more than half the account's rows in the window, above
 * a small count, is refused and reported once (a transient empty 207); and the
 * CalDAV listing has its own occurrence cap (500), so a busy month still removes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const tx = {
    calendarEvent: { findMany: vi.fn(), deleteMany: vi.fn() },
    attentionItem: { updateMany: vi.fn() },
  };
  return {
    tx,
    prisma: {
      calendarEvent: { upsert: vi.fn(async () => ({})) },
      automationConfig: { findUnique: vi.fn(async () => ({ timezone: "Asia/Seoul" })) },
      linkedCalendarAccount: { findMany: vi.fn() },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
  };
});

vi.mock("googleapis", () => ({ google: { calendar: vi.fn(() => ({})) } }));
vi.mock("../mail/gmail.js", () => ({
  getAuthedClient: vi.fn(),
  buildLinkedCalendarClient: vi.fn(),
  markLinkedCalendarForReconnect: vi.fn(async () => {}),
}));
vi.mock("../db.js", () => ({ prisma: db.prisma, db: db.prisma, INTERACTIVE_TX_OPTIONS: {} }));
vi.mock("../crypto-tokens.js", () => ({
  decryptToken: (t: string) => t.replace(/^enc:/, ""),
  encryptToken: (t: string) => `enc:${t}`,
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { bulkEvents, ICLOUD_TIMED, UTC_WITH_DURATION } from "../__fixtures__/caldav/ics.js";
import {
  fakeCaldavServer,
  ICLOUD_CALENDARS,
  ICLOUD_HOME_PATH,
  ICLOUD_PARTITION,
  icloudCalendarsXmlOnly,
  icloudReportXml,
  icloudRoutes,
} from "../__fixtures__/caldav/server.js";
import { _resetCaldavBackoffForTests } from "../pim/caldav/caldav-backoff.js";
import { calendarKeyOf } from "../pim/caldav/caldav-listing.js";
import {
  CALDAV_LISTING_MAX_OCCURRENCES,
  caldavCalendarActions,
} from "../pim/calendar-providers/caldav.js";
import type {
  CalendarSession,
  CalendarWindowListing,
  ProviderCalendarEvent,
} from "../pim/calendar-providers/types.js";
import { isCalendarUnsupported } from "../pim/calendar-providers/types.js";
import { syncLinkedCalendarWindow } from "../pim/calendar-sync.js";
import {
  _resetDeletionValveForTests,
  CALDAV_DELETE_MAX_SHARE,
  CALDAV_DELETE_VALVE_MIN_ROWS,
  removeRowsMissingFromWindow,
} from "../pim/calendar-window-reconcile.js";
import { captureError } from "../sentry.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const BEFORE = new Date("2026-09-30T00:00:00.000Z");
const AFTER = new Date("2026-10-01T00:00:01.000Z");
const [HOME, WORK] = ICLOUD_CALENDARS as [string, string];
const K_HOME = calendarKeyOf(new URL(HOME, `https://${ICLOUD_PARTITION}`));
const K_WORK = calendarKeyOf(new URL(WORK, `https://${ICLOUD_PARTITION}`));
const WINDOW = { timeMin: "2026-10-01T00:00:00.000Z", timeMax: "2026-10-31T00:00:00.000Z" };
const ACCOUNT = "acct-icloud";

function event(externalId: string, start: string, end: string): ProviderCalendarEvent {
  return {
    externalId,
    summary: externalId,
    description: null,
    location: null,
    meetingLink: null,
    start,
    end,
    allDay: false,
    startTime: new Date(start),
    endTime: new Date(end),
  };
}

function listing(
  events: ProviderCalendarEvent[],
  complete: boolean,
  calendarKeys: string[] = [K_HOME, K_WORK],
): CalendarWindowListing {
  return { events, complete, window: WINDOW, listedAt: NOW, calendarKeys };
}

function row(
  id: string,
  externalId: string | null,
  start: string,
  end: string,
  calendar: string | null = K_HOME,
  updatedAt: Date = BEFORE,
) {
  return {
    id,
    externalId,
    startTime: new Date(start),
    endTime: new Date(end),
    updatedAt,
    caldavCalendarKey: calendar,
  };
}

/** `n` rows of the home calendar, one a day from 2026-10-02, ids r-0.. and n-0@x... */
function rows(n: number, calendar: string | null = K_HOME) {
  return Array.from({ length: n }, (_, k) => {
    const start = new Date(Date.UTC(2026, 9, 2 + k, 1)).toISOString();
    const end = new Date(Date.UTC(2026, 9, 2 + k, 2)).toISOString();
    return row(`r-${k}`, `n-${k}@x`, start, end, calendar);
  });
}

const saved = process.env.CALDAV_CALENDAR_ENABLED;
beforeEach(() => {
  _resetCaldavBackoffForTests();
  process.env.CALDAV_CALENDAR_ENABLED = "true";
  vi.clearAllMocks();
  _resetDeletionValveForTests();
  db.tx.attentionItem.updateMany.mockResolvedValue({ count: 0 });
  db.tx.calendarEvent.deleteMany.mockImplementation(async ({ where }) => ({
    count: (where.id.in as string[]).length,
  }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  if (saved === undefined) delete process.env.CALDAV_CALENDAR_ENABLED;
  else process.env.CALDAV_CALENDAR_ENABLED = saved;
  vi.restoreAllMocks();
});

describe("removeRowsMissingFromWindow", () => {
  it("removes the window's rows the complete listing no longer has, and resolves their attention items", async () => {
    db.tx.calendarEvent.findMany.mockResolvedValue([
      row("r-kept", "kept@x", "2026-10-05T01:00:00Z", "2026-10-05T02:00:00Z"),
      row("r-gone", "gone@x", "2026-10-06T01:00:00Z", "2026-10-06T02:00:00Z"),
      row("r-straddle", "straddle@x", "2026-09-30T23:00:00Z", "2026-10-01T01:00:00Z"),
      row("r-ended", "ended@x", "2026-09-30T22:00:00Z", "2026-10-01T00:00:00Z"),
      row("r-after", "after@x", "2026-10-31T00:00:00Z", "2026-10-31T01:00:00Z"),
      // Written by a sync that started after this listing: never taken for vanished.
      row("r-fresh", "fresh@x", "2026-10-07T01:00:00Z", "2026-10-07T02:00:00Z", K_HOME, AFTER),
    ]);
    db.tx.attentionItem.updateMany.mockResolvedValue({ count: 1 });
    const result = await removeRowsMissingFromWindow(
      "ICLOUD",
      "u1",
      ACCOUNT,
      listing([event("kept@x", "2026-10-05T01:00:00Z", "2026-10-05T02:00:00Z")], true),
      NOW,
    );

    expect(result).toEqual({ removed: 2, resolved: 1 });
    const where = db.tx.calendarEvent.findMany.mock.calls[0]?.[0]?.where;
    expect(where).toEqual({
      userId: "u1",
      provider: "ICLOUD",
      sourceAccountId: ACCOUNT,
      sourceKey: ACCOUNT,
      startTime: { lt: new Date(WINDOW.timeMax) },
      endTime: { gte: new Date(WINDOW.timeMin) },
    });
    // Only the two rows inside the window that the listing lacks.
    expect(db.tx.attentionItem.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "u1",
        source: "CALENDAR_EVENT",
        sourceId: { in: ["r-gone", "r-straddle"] },
        status: { in: ["OPEN", "SNOOZED"] },
      },
      data: { status: "RESOLVED", resolvedAt: NOW },
    });
    expect(db.tx.calendarEvent.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", id: { in: ["r-gone", "r-straddle"] } },
    });
  });

  it("an INCOMPLETE listing removes nothing and reads nothing", async () => {
    const result = await removeRowsMissingFromWindow(
      "ICLOUD",
      "u1",
      ACCOUNT,
      listing([], false),
      NOW,
    );
    expect(result).toEqual({ removed: 0, resolved: 0 });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
    expect(db.tx.calendarEvent.deleteMany).not.toHaveBeenCalled();
  });

  it("with CALDAV_CALENDAR_ENABLED off, removes nothing", async () => {
    process.env.CALDAV_CALENDAR_ENABLED = "false";
    await removeRowsMissingFromWindow("NAVER", "u1", ACCOUNT, listing([], true), NOW);
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    "GOOGLE",
    "OUTLOOK",
  ] as const)("never for %s, whatever its listing claims (absence is not a signal there)", async (provider) => {
    await removeRowsMissingFromWindow(provider, "u1", ACCOUNT, listing([], true), NOW);
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("nothing to remove: no attention or delete write", async () => {
    db.tx.calendarEvent.findMany.mockResolvedValue([
      row("r-kept", "kept@x", "2026-10-05T01:00:00Z", "2026-10-05T02:00:00Z"),
    ]);
    const result = await removeRowsMissingFromWindow(
      "ICLOUD",
      "u1",
      ACCOUNT,
      listing([event("kept@x", "2026-10-05T01:00:00Z", "2026-10-05T02:00:00Z")], true),
      NOW,
    );
    expect(result).toEqual({ removed: 0, resolved: 0 });
    expect(db.tx.calendarEvent.deleteMany).not.toHaveBeenCalled();
  });
});

describe("unknown calendars and the deletion valve", () => {
  it("a row of a calendar the discovery did not list is unknown and never removed", async () => {
    db.tx.calendarEvent.findMany.mockResolvedValue([
      row("r-home-gone", "home-gone@x", "2026-10-05T01:00:00Z", "2026-10-05T02:00:00Z", K_HOME),
      row("r-work", "work@x", "2026-10-06T01:00:00Z", "2026-10-06T02:00:00Z", K_WORK),
      row("r-other", "other@x", "2026-10-07T01:00:00Z", "2026-10-07T02:00:00Z", "k-elsewhere"),
      row("r-untagged", "untagged@x", "2026-10-08T01:00:00Z", "2026-10-08T02:00:00Z", null),
    ]);
    const result = await removeRowsMissingFromWindow(
      "ICLOUD",
      "u1",
      ACCOUNT,
      listing([], true, [K_HOME]),
      NOW,
    );
    expect(result.removed).toBe(1);
    expect(db.tx.calendarEvent.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", id: { in: ["r-home-gone"] } },
    });
  });

  it("a complete listing that names no calendar removes nothing", async () => {
    db.tx.calendarEvent.findMany.mockResolvedValue(rows(2));
    await removeRowsMissingFromWindow("ICLOUD", "u1", ACCOUNT, listing([], true, []), NOW);
    expect(db.tx.calendarEvent.deleteMany).not.toHaveBeenCalled();
  });

  it("the valve is more than half, above five rows", () => {
    expect(CALDAV_DELETE_MAX_SHARE).toBe(0.5);
    expect(CALDAV_DELETE_VALVE_MIN_ROWS).toBe(5);
  });

  it.each([
    [5, 5, 5],
    [12, 6, 6],
    [10, 1, 1],
  ])("of %d rows in the window, %d vanished: removed (%d)", async (total, gone, removed) => {
    const all = rows(total);
    db.tx.calendarEvent.findMany.mockResolvedValue(all);
    const kept = all.slice(gone).map((r) => event(r.externalId as string, "", ""));
    const result = await removeRowsMissingFromWindow(
      "ICLOUD",
      "u1",
      ACCOUNT,
      listing(kept, true),
      NOW,
    );
    expect(result.removed).toBe(removed);
    expect(captureError).not.toHaveBeenCalled();
  });

  it.each([
    [6, 6],
    [11, 6],
    [40, 21],
  ])("of %d rows in the window, %d vanished: refused, nothing removed", async (total, gone) => {
    const all = rows(total);
    db.tx.calendarEvent.findMany.mockResolvedValue(all);
    const kept = all.slice(gone).map((r) => event(r.externalId as string, "", ""));
    const result = await removeRowsMissingFromWindow(
      "ICLOUD",
      "u1",
      ACCOUNT,
      listing(kept, true),
      NOW,
    );
    expect(result).toEqual({ removed: 0, resolved: 0 });
    expect(db.tx.calendarEvent.deleteMany).not.toHaveBeenCalled();
    expect(db.tx.attentionItem.updateMany).not.toHaveBeenCalled();
  });

  it("a refusal is logged and sent to Sentry once per account per process", async () => {
    db.tx.calendarEvent.findMany.mockResolvedValue(rows(8));
    await removeRowsMissingFromWindow("ICLOUD", "u1", ACCOUNT, listing([], true), NOW);
    await removeRowsMissingFromWindow("ICLOUD", "u1", ACCOUNT, listing([], true), NOW);
    expect(captureError).toHaveBeenCalledTimes(1);
    const warned = vi.mocked(console.warn).mock.calls.filter((c) => String(c[0]).includes("valve"));
    expect(warned).toHaveLength(1);
    await removeRowsMissingFromWindow("NAVER", "u2", "acct-naver", listing([], true), NOW);
    expect(captureError).toHaveBeenCalledTimes(2);
    expect(db.tx.calendarEvent.deleteMany).not.toHaveBeenCalled();
  });
});

describe("syncLinkedCalendarWindow with a CalDAV session (fake server)", () => {
  async function session(
    routes: Parameters<typeof icloudRoutes>[0],
    calendarsXml?: string,
  ): Promise<CalendarSession> {
    const row = {
      id: ACCOUNT,
      userId: "u1",
      provider: "ICLOUD",
      email: "me@icloud.com",
      caldavPasswordCipher: "enc:pw",
    };
    const opened = await caldavCalendarActions("ICLOUD", {
      transport: fakeCaldavServer({
        ...icloudRoutes(routes),
        ...(calendarsXml
          ? {
              [`PROPFIND ${ICLOUD_PARTITION} ${ICLOUD_HOME_PATH}`]: {
                status: 207,
                body: calendarsXml,
              },
            }
          : {}),
      }),
      resolve: async () => ["17.248.1.10"],
      now: () => NOW.getTime(),
    }).connect({ userId: "u1", linkedAccountId: ACCOUNT, linked: row as never });
    if (!opened || isCalendarUnsupported(opened)) throw new Error("no session");
    return opened;
  }

  const STALE = row(
    "r-stale",
    "deleted-upstream@x",
    "2026-10-08T01:00:00Z",
    "2026-10-08T02:00:00Z",
  );

  it("complete: upserts the listing's rows as ICLOUD, then removes the stale one", async () => {
    db.tx.calendarEvent.findMany.mockResolvedValue([STALE]);
    const s = await session({
      [HOME]: { status: 207, body: icloudReportXml([ICLOUD_TIMED]) },
      [WORK]: { status: 207, body: icloudReportXml([UTC_WITH_DURATION]) },
    });
    const written = await syncLinkedCalendarWindow(s, "u1", ACCOUNT, "Asia/Seoul", NOW);
    expect(written).toBe(2);
    const created = db.prisma.calendarEvent.upsert.mock.calls.map(
      (call) =>
        (call[0] as { create: { provider: string; sourceKey: string; caldavCalendarKey: string } })
          .create,
    );
    expect(created.map((c) => [c.provider, c.sourceKey, c.caldavCalendarKey])).toEqual([
      ["ICLOUD", ACCOUNT, K_HOME],
      ["ICLOUD", ACCOUNT, K_WORK],
    ]);
    expect(db.tx.calendarEvent.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", id: { in: ["r-stale"] } },
    });
  });

  it("partial (one calendar failed): upserts what it read and removes NOTHING", async () => {
    db.tx.calendarEvent.findMany.mockResolvedValue([STALE]);
    const s = await session({
      [HOME]: { status: 503 },
      [WORK]: { status: 207, body: icloudReportXml([UTC_WITH_DURATION]) },
    });
    expect(await syncLinkedCalendarWindow(s, "u1", ACCOUNT, "Asia/Seoul", NOW)).toBe(1);
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
    expect(db.tx.calendarEvent.deleteMany).not.toHaveBeenCalled();
  });

  it("over the CalDAV occurrence cap: upserts the cap and removes NOTHING", async () => {
    expect(CALDAV_LISTING_MAX_OCCURRENCES).toBe(500);
    db.tx.calendarEvent.findMany.mockResolvedValue([STALE]);
    const s = await session({
      [HOME]: {
        status: 207,
        body: icloudReportXml(bulkEvents(CALDAV_LISTING_MAX_OCCURRENCES + 1)),
      },
      [WORK]: { status: 207, body: icloudReportXml([]) },
    });
    expect(await syncLinkedCalendarWindow(s, "u1", ACCOUNT, "Asia/Seoul", NOW)).toBe(
      CALDAV_LISTING_MAX_OCCURRENCES,
    );
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  // CALENDAR_SYNC_MAX_RESULTS (100) is Google's page size; a CalDAV month of 150
  // occurrences is still complete, so the stale row goes.
  it("over 100 occurrences but under the CalDAV cap: complete, the stale row is removed", async () => {
    db.tx.calendarEvent.findMany.mockResolvedValue([STALE]);
    const s = await session({
      [HOME]: { status: 207, body: icloudReportXml(bulkEvents(150)) },
      [WORK]: { status: 207, body: icloudReportXml([]) },
    });
    expect(await syncLinkedCalendarWindow(s, "u1", ACCOUNT, "Asia/Seoul", NOW)).toBe(150);
    expect(db.tx.calendarEvent.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", id: { in: ["r-stale"] } },
    });
  });

  it("an empty 207 from every calendar while the window has rows: the valve keeps them", async () => {
    db.tx.calendarEvent.findMany.mockResolvedValue(rows(8));
    const s = await session({
      [HOME]: { status: 207, body: icloudReportXml([]) },
      [WORK]: { status: 207, body: icloudReportXml([]) },
    });
    expect(await syncLinkedCalendarWindow(s, "u1", ACCOUNT, "Asia/Seoul", NOW)).toBe(0);
    expect(db.tx.calendarEvent.deleteMany).not.toHaveBeenCalled();
    expect(db.tx.attentionItem.updateMany).not.toHaveBeenCalled();
    expect(captureError).toHaveBeenCalledTimes(1);
  });

  it("a calendar missing from discovery: its rows are kept, the listed calendar's stale row goes", async () => {
    const workRow = row(
      "r-work",
      "work-event@x",
      "2026-10-09T01:00:00Z",
      "2026-10-09T02:00:00Z",
      K_WORK,
    );
    db.tx.calendarEvent.findMany.mockResolvedValue([STALE, workRow]);
    const s = await session(
      { [HOME]: { status: 207, body: icloudReportXml([ICLOUD_TIMED]) } },
      icloudCalendarsXmlOnly(["home/"]),
    );
    expect(await syncLinkedCalendarWindow(s, "u1", ACCOUNT, "Asia/Seoul", NOW)).toBe(1);
    expect(db.tx.calendarEvent.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", id: { in: ["r-stale"] } },
    });
  });

  it("a parse budget spent mid-listing truncates it: removes NOTHING", async () => {
    db.tx.calendarEvent.findMany.mockResolvedValue([STALE]);
    const row0 = {
      id: ACCOUNT,
      userId: "u1",
      provider: "ICLOUD",
      email: "me@icloud.com",
      caldavPasswordCipher: "enc:pw",
    };
    const opened = await caldavCalendarActions("ICLOUD", {
      transport: fakeCaldavServer(
        icloudRoutes({
          [HOME]: { status: 207, body: icloudReportXml([ICLOUD_TIMED]) },
          [WORK]: { status: 207, body: icloudReportXml([UTC_WITH_DURATION]) },
        }),
      ),
      resolve: async () => ["17.248.1.10"],
      now: () => NOW.getTime(),
      parse: { budgetMs: 0 },
    }).connect({ userId: "u1", linkedAccountId: ACCOUNT, linked: row0 as never });
    if (!opened || isCalendarUnsupported(opened)) throw new Error("no session");
    await syncLinkedCalendarWindow(opened, "u1", ACCOUNT, "Asia/Seoul", NOW);
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("server-side truncation (507): removes NOTHING", async () => {
    db.tx.calendarEvent.findMany.mockResolvedValue([STALE]);
    const cut = `<multistatus xmlns="DAV:"><response><href>${HOME}</href><status>HTTP/1.1 507 Insufficient Storage</status></response></multistatus>`;
    const s = await session({
      [HOME]: { status: 207, body: cut },
      [WORK]: { status: 207, body: icloudReportXml([]) },
    });
    await syncLinkedCalendarWindow(s, "u1", ACCOUNT, "Asia/Seoul", NOW);
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("a listing that throws (every calendar failed) removes nothing and propagates", async () => {
    const s = await session({ [HOME]: { status: 500 }, [WORK]: { status: 500 } });
    await expect(
      syncLinkedCalendarWindow(s, "u1", ACCOUNT, "Asia/Seoul", NOW),
    ).rejects.toMatchObject({
      status: 500,
    });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("a session without listWindow (Google, Outlook) syncs exactly as before: no removal", async () => {
    const listEvents = vi.fn(async () => [
      event("g1", "2026-10-05T01:00:00.000Z", "2026-10-05T02:00:00.000Z"),
    ]);
    const google = { provider: "GOOGLE", listEvents } as unknown as CalendarSession;
    expect(await syncLinkedCalendarWindow(google, "u1", "acct-g", "Asia/Seoul", NOW)).toBe(1);
    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });
});
