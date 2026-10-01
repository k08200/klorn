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
  icloudReportXml,
  icloudRoutes,
} from "../__fixtures__/caldav/server.js";
import { caldavCalendarActions } from "../pim/calendar-providers/caldav.js";
import type {
  CalendarSession,
  CalendarWindowListing,
  ProviderCalendarEvent,
} from "../pim/calendar-providers/types.js";
import { isCalendarUnsupported } from "../pim/calendar-providers/types.js";
import { syncLinkedCalendarWindow } from "../pim/calendar-sync.js";
import { removeRowsMissingFromWindow } from "../pim/calendar-window-reconcile.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
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

function listing(events: ProviderCalendarEvent[], complete: boolean): CalendarWindowListing {
  return { events, complete, window: WINDOW, listedAt: NOW };
}

function row(id: string, externalId: string | null, start: string, end: string) {
  return { id, externalId, startTime: new Date(start), endTime: new Date(end) };
}

const saved = process.env.CALDAV_CALENDAR_ENABLED;
beforeEach(() => {
  process.env.CALDAV_CALENDAR_ENABLED = "true";
  vi.clearAllMocks();
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
      updatedAt: { lt: NOW },
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

describe("syncLinkedCalendarWindow with a CalDAV session (fake server)", () => {
  const [HOME, WORK] = ICLOUD_CALENDARS as [string, string];

  async function session(routes: Parameters<typeof icloudRoutes>[0]): Promise<CalendarSession> {
    const row = {
      id: ACCOUNT,
      userId: "u1",
      provider: "ICLOUD",
      email: "me@icloud.com",
      caldavPasswordCipher: "enc:pw",
    };
    const opened = await caldavCalendarActions("ICLOUD", {
      transport: fakeCaldavServer(icloudRoutes(routes)),
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
      (call) => (call[0] as { create: { provider: string; sourceKey: string } }).create,
    );
    expect(created.map((c) => [c.provider, c.sourceKey])).toEqual([
      ["ICLOUD", ACCOUNT],
      ["ICLOUD", ACCOUNT],
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

  it("truncated (over 100 occurrences): removes NOTHING", async () => {
    db.tx.calendarEvent.findMany.mockResolvedValue([STALE]);
    const s = await session({
      [HOME]: { status: 207, body: icloudReportXml(bulkEvents(101)) },
      [WORK]: { status: 207, body: icloudReportXml([]) },
    });
    expect(await syncLinkedCalendarWindow(s, "u1", ACCOUNT, "Asia/Seoul", NOW)).toBe(100);
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
