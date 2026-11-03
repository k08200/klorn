/**
 * Per-contact co-attendance counts (founder decision 2026-11-01): from ended
 * meetings, keep only how many meetings the user shared with each address, how
 * many were small, and the first and last; never an attendee list. Behind
 * CALENDAR_COATTENDANCE_ENABLED (off by default): off, nothing is listed, read or
 * written. Each meeting is counted once across repeated syncs and across the
 * user's calendars, through a marker that holds a hash of the meeting's identity
 * and the day it ended, nothing more. No column of either table is finer than a
 * day, so rows written together cannot be grouped back into one meeting by time.
 * Each Google calendar source records when it was first observed and its last
 * successful pass (the persisted 6-hour interval).
 *
 * The rows live in the strict fake database, so every query is checked against
 * the real schema and every write is recorded.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fake-db.js";

const h = vi.hoisted(() => ({
  db: null as unknown,
  captureError: vi.fn(),
  connectLinkedCalendars: vi.fn(),
  connectPrimaryCalendar: vi.fn(),
}));

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => h.db as FakeDb, { rollbackOnError: true });
  return {
    prisma,
    db: prisma,
    INTERACTIVE_TX_OPTIONS: { maxWait: 10_000, timeout: 15_000 },
  };
});
vi.mock("../sentry.js", () => ({ captureError: h.captureError }));
vi.mock("../pim/calendar-providers/dispatch.js", () => ({
  connectLinkedCalendars: h.connectLinkedCalendars,
  connectPrimaryCalendar: h.connectPrimaryCalendar,
}));

import type {
  CalendarSession,
  MeetingAttendee,
  ProviderCalendarEvent,
  ProviderMeeting,
} from "../pim/calendar-providers/types.js";
import {
  syncLinkedCalendars,
  syncLinkedCalendarWindow,
  syncPrimaryCalendarWindow,
} from "../pim/calendar-sync.js";
import {
  _drainCoAttendanceQueueForTests,
  enqueueCoAttendance,
  runCoAttendanceForUser,
} from "../pim/coattendance/coattendance-job.js";
import type { CountedMeeting } from "../pim/coattendance/coattendance-rules.js";
import {
  CONTACTS_PER_TRANSACTION,
  claimAndCount,
  eventKeyOf,
  MEETINGS_PER_TRANSACTION,
  planBatches,
} from "../pim/coattendance/coattendance-store.js";
import {
  _resetCoAttendancePassesForTests,
  COATTENDANCE_FAILURE_BACKOFF_MS,
  COATTENDANCE_LOOKBACK_DAYS,
  COATTENDANCE_PASS_INTERVAL_MS,
  countCoAttendance,
} from "../pim/coattendance/coattendance-sync.js";
import { DataWipeFenceError } from "../privacy/data-wipe-fence.js";

const FLAG = "CALENDAR_COATTENDANCE_ENABLED";
const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = new Date("2026-11-01T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const ZONE = "Asia/Seoul";
const ATTENDEE_EMAILS = ["ana@client.example", "bo@client.example", "cy@vendor.example"];

type Rows = Record<string, Array<Record<string, unknown>>>;
let db: FakeDb;
const tables = () => db.tables as Rows;
const saved = process.env[FLAG];

function person(email: string, responseStatus = "accepted", extra = {}): MeetingAttendee {
  return { email, self: false, organizer: false, resource: false, responseStatus, ...extra };
}

const me: MeetingAttendee = person("me@example.com", "accepted", { self: true });

function meeting(identity: string, start: string, attendees: MeetingAttendee[]): ProviderMeeting {
  const startTime = new Date(start);
  return {
    identity,
    cancelled: false,
    allDay: false,
    startTime,
    endTime: new Date(startTime.getTime() + 60 * 60 * 1000),
    attendeesOmitted: false,
    organizedBySelf: false,
    attendees,
  };
}

const standup = meeting("ical:standup@google.com|", "2026-10-30T01:00:00.000Z", [
  me,
  person("Ana@Client.Example"),
  person("bo@client.example"),
  // The user's other addresses, as Klorn knows them from their accounts.
  person("ME@work.example"),
  person("me@gmail.com"),
  person("me@side.example", "tentative"),
]);
const allHands = meeting("ical:allhands@google.com|", "2026-10-28T01:00:00.000Z", [
  me,
  ...["ana@client.example", "cy@vendor.example"].map((e) => person(e)),
  ...[1, 2, 3, 4].map((i) => person(`staff${i}@example.org`)),
]);

function upcoming(id: string): ProviderCalendarEvent {
  return {
    externalId: id,
    summary: "Upcoming",
    description: null,
    location: null,
    meetingLink: null,
    start: "2026-11-02T10:00:00+09:00",
    end: "2026-11-02T11:00:00+09:00",
    allDay: false,
    startTime: new Date("2026-11-02T01:00:00.000Z"),
    endTime: new Date("2026-11-02T02:00:00.000Z"),
  };
}

function googleSession(meetings: ProviderMeeting[], truncated = false) {
  const listMeetingAttendees = vi.fn(async () => ({ meetings, truncated }));
  const session = {
    provider: "GOOGLE",
    listEvents: vi.fn(async () => [upcoming("up-1")]),
    listMeetingAttendees,
  } as unknown as CalendarSession;
  return { session, listMeetingAttendees };
}

function seed(extra: Rows = {}) {
  db = createFakeDb({
    user: [{ id: "u1", email: "me@example.com" }],
    userToken: [
      { id: "t1", userId: "u1", provider: "google", accessToken: "x", googleEmail: "me@gmail.com" },
    ],
    linkedCalendarAccount: [
      { id: "lc1", userId: "u1", email: "Me@Work.Example" },
      { id: "lc2", userId: "u1", provider: "OUTLOOK", email: "me@outlook.example" },
    ],
    linkedInboxAccount: [{ id: "li1", userId: "u1", email: "me@side.example" }],
    ...extra,
  });
  h.db = db;
}

const at = (iso: string) => new Date(iso);
const isMidnight = (value: unknown) => value instanceof Date && value.getTime() % DAY_MS === 0;
const source = (model: "userToken" | "linkedCalendarAccount", id: string) =>
  tables()[model]?.find((r) => r.id === id);

const counters = () =>
  Object.fromEntries(
    (tables().contactCoAttendance ?? []).map((r) => [
      r.contactEmail,
      {
        meetingCount: r.meetingCount,
        smallMeetingCount: r.smallMeetingCount,
        firstMetAt: r.firstMetAt,
        lastMetAt: r.lastMetAt,
      },
    ]),
  );

function allLoggedText(): string {
  const spies = [console.log, console.warn, console.error, console.info] as unknown as Array<{
    mock?: { calls: unknown[][] };
  }>;
  const logged = spies.flatMap((spy) => spy.mock?.calls ?? []);
  return JSON.stringify([logged, h.captureError.mock.calls], (_k, v) =>
    v instanceof Error ? `${v.name}: ${v.message}` : v,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetCoAttendancePassesForTests();
  process.env[FLAG] = "true";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  seed();
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
  vi.restoreAllMocks();
});

describe("flag off", () => {
  it("lists nothing, reads nothing and writes nothing", async () => {
    delete process.env[FLAG];
    const { session, listMeetingAttendees } = googleSession([standup]);
    expect(await countCoAttendance(session, "u1", null, NOW)).toBeNull();
    await runCoAttendanceForUser("u1", { includeLinked: true }, NOW);
    enqueueCoAttendance("u1", { includeLinked: true });
    await _drainCoAttendanceQueueForTests();
    expect(listMeetingAttendees).not.toHaveBeenCalled();
    expect(h.connectPrimaryCalendar).not.toHaveBeenCalled();
    expect(h.connectLinkedCalendars).not.toHaveBeenCalled();
    expect(db.reads).toEqual([]);
    expect(db.writes).toEqual({});
  });

  it("leaves the row sync exactly as it was", async () => {
    process.env[FLAG] = "false";
    const { session, listMeetingAttendees } = googleSession([standup]);
    expect(await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW)).toBe(1);
    expect(listMeetingAttendees).not.toHaveBeenCalled();
    expect(Object.keys(db.writes)).toEqual(["calendarEvent"]);
  });
});

describe("counting", () => {
  it("lists the past window and counts each contact of each ended meeting", async () => {
    const { session, listMeetingAttendees } = googleSession([standup, allHands]);
    const result = await countCoAttendance(session, "u1", null, NOW);

    expect(listMeetingAttendees).toHaveBeenCalledWith({
      timeMin: new Date(NOW.getTime() - COATTENDANCE_LOOKBACK_DAYS * DAY_MS).toISOString(),
      timeMax: NOW.toISOString(),
    });
    expect(result).toEqual({ meetings: 2, contacts: 7, truncated: false });
    // Days, not instants: the start of the meeting's UTC day.
    expect(counters()).toMatchObject({
      "ana@client.example": {
        meetingCount: 2,
        smallMeetingCount: 1,
        firstMetAt: at("2026-10-28T00:00:00.000Z"),
        lastMetAt: at("2026-10-30T00:00:00.000Z"),
      },
      "bo@client.example": { meetingCount: 1, smallMeetingCount: 1 },
      "cy@vendor.example": { meetingCount: 1, smallMeetingCount: 0 },
    });
    // The user's own addresses, from every account Klorn knows, are never counted.
    const counted = Object.keys(counters());
    for (const own of ["me@example.com", "me@work.example", "me@gmail.com", "me@side.example"]) {
      expect(counted).not.toContain(own);
    }
    expect(counted).toHaveLength(7);
  });

  it("counts nothing from a meeting the user declined, and writes no marker for it", async () => {
    const declined = meeting("ical:declined@google.com|", "2026-10-29T01:00:00.000Z", [
      { ...me, responseStatus: "declined" },
      person("ana@client.example"),
    ]);
    const { session } = googleSession([declined]);
    expect(await countCoAttendance(session, "u1", null, NOW)).toEqual({
      meetings: 0,
      contacts: 0,
      truncated: false,
    });
    expect(tables().contactCoAttendance ?? []).toEqual([]);
    expect(tables().coAttendanceMeeting ?? []).toEqual([]);
  });

  it("reports a listing cut at its page cap", async () => {
    const { session } = googleSession([standup], true);
    expect(await countCoAttendance(session, "u1", null, NOW)).toMatchObject({ truncated: true });
  });

  it("reads no own addresses when the window has no meetings", async () => {
    const { session } = googleSession([]);
    await countCoAttendance(session, "u1", null, NOW);
    expect(db.reads).not.toContain("user");
    expect(db.reads).not.toContain("linkedInboxAccount");
  });

  it("does nothing for a session that cannot list attendees (Outlook, CalDAV)", async () => {
    const session = { provider: "OUTLOOK", listEvents: vi.fn(async () => []) };
    expect(await countCoAttendance(session as never, "u1", "lc2", NOW)).toBeNull();
    expect(db.reads).toEqual([]);
    expect(db.writes).toEqual({});
  });

  it("does nothing for a source Klorn has no Google row for", async () => {
    const { session, listMeetingAttendees } = googleSession([standup]);
    expect(await countCoAttendance(session, "u1", "lc2", NOW)).toBeNull();
    expect(await countCoAttendance(session, "u1", "gone", NOW)).toBeNull();
    expect(listMeetingAttendees).not.toHaveBeenCalled();
  });
});

describe("per-source markers: observed since, last pass", () => {
  const firstDay = at("2026-10-02T00:00:00.000Z");

  it("the first successful pass records the window's first UTC day and the pass time", async () => {
    const { session } = googleSession([standup]);
    await countCoAttendance(session, "u1", null, NOW);
    await countCoAttendance(session, "u1", "lc1", NOW);
    for (const row of [source("userToken", "t1"), source("linkedCalendarAccount", "lc1")]) {
      expect(row).toMatchObject({
        coAttendanceObservedSince: firstDay,
        coAttendanceLastPassAt: NOW,
      });
    }
    expect(source("linkedCalendarAccount", "lc2")).toMatchObject({
      coAttendanceObservedSince: null,
      coAttendanceLastPassAt: null,
    });
  });

  it("a later pass moves the pass time and never the observed-since day", async () => {
    const { session } = googleSession([standup]);
    await countCoAttendance(session, "u1", null, NOW);
    const later = new Date(NOW.getTime() + COATTENDANCE_PASS_INTERVAL_MS);
    await countCoAttendance(session, "u1", null, later);
    expect(source("userToken", "t1")).toMatchObject({
      coAttendanceObservedSince: firstDay,
      coAttendanceLastPassAt: later,
    });
  });

  it("the interval is persisted: a restarted process still waits for it", async () => {
    const { session, listMeetingAttendees } = googleSession([standup]);
    await countCoAttendance(session, "u1", null, NOW);
    _resetCoAttendancePassesForTests();
    const soon = new Date(NOW.getTime() + COATTENDANCE_PASS_INTERVAL_MS - 1);
    expect(await countCoAttendance(session, "u1", null, soon)).toBeNull();
    expect(listMeetingAttendees).toHaveBeenCalledTimes(1);
    // Another source of the same user has its own interval.
    await countCoAttendance(session, "u1", "lc1", soon);
    expect(listMeetingAttendees).toHaveBeenCalledTimes(2);
  });

  it("a failed pass does not use the interval: it backs off in memory, then retries", async () => {
    const { session, listMeetingAttendees } = googleSession([standup]);
    listMeetingAttendees.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await countCoAttendance(session, "u1", null, NOW)).toBeNull();
    expect(source("userToken", "t1")).toMatchObject({
      coAttendanceObservedSince: null,
      coAttendanceLastPassAt: null,
    });
    const soon = new Date(NOW.getTime() + COATTENDANCE_FAILURE_BACKOFF_MS - 1);
    expect(await countCoAttendance(session, "u1", null, soon)).toBeNull();
    expect(listMeetingAttendees).toHaveBeenCalledTimes(1);
    const after = new Date(NOW.getTime() + COATTENDANCE_FAILURE_BACKOFF_MS);
    expect(await countCoAttendance(session, "u1", null, after)).toMatchObject({ meetings: 1 });
    expect(source("userToken", "t1")).toMatchObject({ coAttendanceLastPassAt: after });
    expect(COATTENDANCE_FAILURE_BACKOFF_MS).toBeLessThan(COATTENDANCE_PASS_INTERVAL_MS);
  });

  it("re-linking or reconnecting a Google calendar clears both markers", () => {
    const text = readFileSync(join(srcDir, "routes/google-link-finish.ts"), "utf8");
    for (const call of ["prisma.linkedCalendarAccount.upsert(", "prisma.userToken.upsert("]) {
      const from = text.indexOf(call);
      expect(from, call).toBeGreaterThan(0);
      const window = text.slice(from, from + 2000);
      const update = window.slice(window.indexOf("update: {"));
      const branch = update.slice(0, update.indexOf("\n        },") + 1 || undefined);
      expect(branch, call).toContain("coAttendanceObservedSince: null");
      expect(branch, call).toContain("coAttendanceLastPassAt: null");
    }
  });
});

describe("one UTC day at a time", () => {
  it("counts a meeting that ended today only after the day is over", async () => {
    const today = meeting("ical:today@google.com|", "2026-11-01T08:00:00.000Z", [
      me,
      person("ana@client.example"),
    ]);
    const { session } = googleSession([today]);
    expect(await countCoAttendance(session, "u1", null, NOW)).toMatchObject({ meetings: 0 });
    expect(tables().coAttendanceMeeting ?? []).toEqual([]);
    const tomorrow = at("2026-11-02T00:30:00.000Z");
    expect(await countCoAttendance(session, "u1", null, tomorrow)).toMatchObject({ meetings: 1 });
    expect(counters()["ana@client.example"]?.lastMetAt).toEqual(at("2026-11-01T00:00:00.000Z"));
  });

  it("keeps a meeting's marker for as long as any pass can still list it", async () => {
    // A meeting ending just after midnight, passes every 6 hours until it leaves
    // the 30-day window: counted once, at its first pass after its day ended, and
    // its marker never pruned while the listing still returns it.
    const end = at("2026-10-01T00:00:01.000Z");
    const late = {
      ...meeting("ical:edge@google.com|", "2026-09-30T23:00:01.000Z", [
        me,
        person("ana@x.example"),
      ]),
      endTime: end,
    };
    for (
      let t = end.getTime();
      t < end.getTime() + 32 * DAY_MS;
      t += COATTENDANCE_PASS_INTERVAL_MS
    ) {
      const now = new Date(t);
      const listed = end.getTime() > t - COATTENDANCE_LOOKBACK_DAYS * DAY_MS;
      await countCoAttendance(googleSession(listed ? [late] : []).session, "u1", null, now);
      const counted = (counters()["ana@x.example"]?.meetingCount as number | undefined) ?? 0;
      expect(counted, now.toISOString()).toBe(
        t >= at("2026-10-02T00:00:00.000Z").getTime() ? 1 : 0,
      );
      if (listed && counted === 1) {
        expect(tables().coAttendanceMeeting ?? [], now.toISOString()).toHaveLength(1);
      }
    }
  });
});

describe("idempotency", () => {
  it("never counts a meeting twice across repeated passes", async () => {
    const { session } = googleSession([standup, allHands]);
    await countCoAttendance(session, "u1", null, NOW);
    const first = counters();
    for (const hours of [6, 12, 18]) {
      const later = new Date(NOW.getTime() + hours * 60 * 60 * 1000);
      expect(await countCoAttendance(session, "u1", null, later)).toMatchObject({ meetings: 0 });
    }
    expect(counters()).toEqual(first);
    expect(tables().coAttendanceMeeting).toHaveLength(2);
  });

  it("counts a meeting once when it sits in the primary and a linked calendar", async () => {
    const { session } = googleSession([standup]);
    await countCoAttendance(session, "u1", null, NOW);
    await countCoAttendance(session, "u1", "lc1", NOW);
    expect(counters()["ana@client.example"]?.meetingCount).toBe(1);
  });

  it("counts a meeting newly ended since the last pass, and moves first/last met", async () => {
    await countCoAttendance(googleSession([standup]).session, "u1", null, NOW);
    const later = new Date(NOW.getTime() + COATTENDANCE_PASS_INTERVAL_MS);
    const earlier = meeting("ical:kickoff@google.com|", "2026-10-10T01:00:00.000Z", [
      me,
      person("ana@client.example"),
    ]);
    await countCoAttendance(googleSession([earlier, standup]).session, "u1", null, later);
    expect(counters()["ana@client.example"]).toEqual({
      meetingCount: 2,
      smallMeetingCount: 2,
      firstMetAt: at("2026-10-10T00:00:00.000Z"),
      lastMetAt: at("2026-10-30T00:00:00.000Z"),
    });
  });

  it("a second claim of the same meeting (a concurrent pass) changes nothing", async () => {
    const counted = {
      identity: "ical:race@google.com|",
      startTime: at("2026-10-30T01:00:00.000Z"),
      endTime: at("2026-10-30T02:00:00.000Z"),
      contacts: ["ana@client.example"],
      small: true,
    };
    expect(await claimAndCount("GOOGLE", "u1", [counted])).toBe(1);
    expect(await claimAndCount("GOOGLE", "u1", [counted])).toBe(0);
    expect(counters()["ana@client.example"]?.meetingCount).toBe(1);
  });

  it("forgets markers of meetings that ended before the window, never one a pass can list", async () => {
    // A pass lists meetings that end after now − 30 days; a marker keeps only the
    // day the meeting ended, so it is kept one day longer than that.
    const windowStart = NOW.getTime() - COATTENDANCE_LOOKBACK_DAYS * DAY_MS;
    const stillListed = new Date(windowStart + 1);
    const dayOf = (t: number) => new Date(Math.floor(t / DAY_MS) * DAY_MS);
    seed({
      coAttendanceMeeting: [
        {
          id: "m-old",
          userId: "u1",
          provider: "GOOGLE",
          eventKey: "a".repeat(64),
          endedAt: dayOf(windowStart - DAY_MS),
        },
        {
          id: "m-edge",
          userId: "u1",
          provider: "GOOGLE",
          eventKey: "b".repeat(64),
          endedAt: dayOf(stillListed.getTime()),
        },
        {
          id: "m-other",
          userId: "u2",
          provider: "GOOGLE",
          eventKey: "c".repeat(64),
          endedAt: dayOf(windowStart - DAY_MS),
        },
      ],
    });
    await countCoAttendance(googleSession([]).session, "u1", null, NOW);
    expect(
      tables()
        .coAttendanceMeeting?.map((r) => r.id)
        .sort(),
    ).toEqual(["m-edge", "m-other"]);
  });
});

describe("batches", () => {
  const many = (n: number, contactsEach: number, prefix: string): CountedMeeting[] =>
    Array.from({ length: n }, (_, i) => ({
      identity: `ical:${prefix}${i}|`,
      startTime: at("2026-10-20T01:00:00.000Z"),
      endTime: at("2026-10-20T02:00:00.000Z"),
      contacts: Array.from({ length: contactsEach }, (_, c) => `${prefix}${i}-${c}@x.example`),
      small: contactsEach <= 4,
    }));

  const onDay = (meetings: CountedMeeting[], day: string): CountedMeeting[] =>
    meetings.map((m) => ({
      ...m,
      startTime: at(`${day}T01:00:00.000Z`),
      endTime: at(`${day}T02:00:00.000Z`),
    }));

  it("writes each UTC end-day in its own transaction, the whole day together", () => {
    const day1 = onDay(many(3, 2, "a"), "2026-10-20");
    const day2 = onDay(many(2, 2, "b"), "2026-10-21");
    const batches = planBatches([...day2, day1[0], ...day1.slice(1)].reverse());
    expect(batches.map((b) => b.length)).toEqual([3, 2]);
    expect(batches[0]?.every((m) => m.endTime.getTime() === day1[0]?.endTime.getTime())).toBe(true);
    expect(batches[1]?.every((m) => m.endTime.getTime() === day2[0]?.endTime.getTime())).toBe(true);
  });

  it("splits only a day over a cap, in marker-key order, and never mixes days", () => {
    const big = onDay(many(27, 2, "c"), "2026-10-20");
    const small = onDay(many(1, 2, "d"), "2026-10-20");
    const next = onDay(many(1, 2, "e"), "2026-10-21");
    const batches = planBatches([...next, ...big, ...small]);
    expect(batches.map((b) => b.length)).toEqual([25, 3, 1]);
    const day20 = batches
      .slice(0, 2)
      .flat()
      .map((m) => eventKeyOf(m.identity));
    expect(day20).toEqual([...day20].sort());
    expect(batches[2]?.[0]?.identity).toBe(next[0]?.identity);
  });

  it("orders each batch by marker key, at most 25 meetings", () => {
    const batches = planBatches(many(60, 2, "m"));
    expect(batches.map((b) => b.length)).toEqual([25, 25, 10]);
    const keys = batches.flat().map((m) => eventKeyOf(m.identity));
    expect(keys).toEqual([...keys].sort());
    expect(MEETINGS_PER_TRANSACTION).toBe(25);
  });

  it("closes a batch before it would pass 200 distinct contacts", () => {
    expect(CONTACTS_PER_TRANSACTION).toBe(200);
    const batches = planBatches(many(10, 50, "w"));
    expect(batches.map((b) => b.length)).toEqual([4, 4, 2]);
    for (const batch of batches) {
      expect(new Set(batch.flatMap((m) => m.contacts)).size).toBeLessThanOrEqual(200);
    }
  });
});

describe("no attendee data outside the counters", () => {
  it("writes only counters, markers and the source's pass markers; nothing finer than a day", async () => {
    const { session } = googleSession([standup, allHands]);
    await countCoAttendance(session, "u1", null, NOW);

    expect(Object.keys(db.writes).sort()).toEqual([
      "coAttendanceMeeting",
      "contactCoAttendance",
      "userToken",
    ]);
    const markers = tables().coAttendanceMeeting ?? [];
    expect(markers.map((r) => Object.keys(r).sort())).toEqual(
      markers.map(() => ["endedAt", "eventKey", "id", "provider", "userId"]),
    );
    for (const marker of markers) {
      expect(marker.eventKey).toMatch(/^[0-9a-f]{64}$/);
      expect(isMidnight(marker.endedAt)).toBe(true);
    }
    expect(markers.map((r) => r.eventKey).sort()).toEqual(
      [eventKeyOf(standup.identity), eventKeyOf(allHands.identity)].sort(),
    );
    const markerText = JSON.stringify(db.writes.coAttendanceMeeting);
    expect(markerText).not.toContain("@");
    expect(markerText).not.toContain("standup");

    // A counter row is one address, numbers and two days: no other attendee, no time.
    for (const row of tables().contactCoAttendance ?? []) {
      expect(Object.keys(row).sort()).toEqual([
        "contactEmail",
        "firstMetAt",
        "id",
        "lastMetAt",
        "meetingCount",
        "smallMeetingCount",
        "userId",
      ]);
      expect(isMidnight(row.firstMetAt) && isMidnight(row.lastMetAt)).toBe(true);
    }
    // What a write would store (create, update, data) names at most one address;
    // only a filter (`where`) may name several, and a filter stores nothing.
    for (const write of db.writes.contactCoAttendance ?? []) {
      const stored = JSON.stringify([write.data, write.update]);
      const mentioned = ATTENDEE_EMAILS.filter((e) => stored.includes(e));
      expect(mentioned.length).toBeLessThanOrEqual(1);
      if (write.op === "update") expect(stored).not.toContain("@");
    }
    for (const write of db.writes.userToken ?? []) {
      expect(Object.keys(write.data ?? {}).sort()).toEqual([
        "coAttendanceLastPassAt",
        "coAttendanceObservedSince",
      ]);
    }
  });

  it("puts no attendee data in the synced rows or in any log line", async () => {
    const { session } = googleSession([standup, allHands]);
    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);
    await countCoAttendance(session, "u1", null, NOW);
    expect(counters()["ana@client.example"]?.meetingCount).toBe(2);

    const rowText = JSON.stringify(db.writes.calendarEvent);
    for (const email of [...ATTENDEE_EMAILS, "Ana@Client.Example"]) {
      expect(rowText).not.toContain(email);
    }
    const logged = allLoggedText();
    for (const email of [...ATTENDEE_EMAILS, "Ana@Client.Example", "staff1@example.org"]) {
      expect(logged).not.toContain(email);
    }
  });

  it("a failure never throws and never logs what the error carried", async () => {
    const { session, listMeetingAttendees } = googleSession([standup]);
    listMeetingAttendees.mockRejectedValue(
      Object.assign(new Error("Invalid upsert: contactEmail ana@client.example"), {
        code: "P2009",
      }),
    );
    expect(await countCoAttendance(session, "u1", null, NOW)).toBeNull();
    expect(h.captureError).toHaveBeenCalledTimes(1);
    expect(h.captureError.mock.calls[0]?.[1]).toMatchObject({
      tags: { scope: "calendar.coattendance" },
    });
    expect(allLoggedText()).not.toContain("ana@client.example");
    expect(allLoggedText()).toContain("P2009");
  });

  it("does not report a write the data-wipe fence refused: the wipe is expected", async () => {
    const { session, listMeetingAttendees } = googleSession([standup]);
    listMeetingAttendees.mockRejectedValue(new DataWipeFenceError());
    expect(await countCoAttendance(session, "u1", null, NOW)).toBeNull();
    expect(h.captureError).not.toHaveBeenCalled();
  });

  it("a counter write that fails rolls its meeting's marker back, so the next pass retries", async () => {
    const { session } = googleSession([standup]);
    const original = db.model("contactCoAttendance").upsert;
    db.model("contactCoAttendance").upsert = () =>
      Promise.reject(new Error("write failed for bo@client.example"));
    await countCoAttendance(session, "u1", null, NOW);
    expect(tables().coAttendanceMeeting ?? []).toEqual([]);
    expect(allLoggedText()).not.toContain("bo@client.example");

    db.model("contactCoAttendance").upsert = original;
    _resetCoAttendancePassesForTests();
    await countCoAttendance(session, "u1", null, NOW);
    expect(counters()["bo@client.example"]?.meetingCount).toBe(1);
  });
});

describe("the scheduler's job", () => {
  it("counts the primary and each due Google linked calendar, never another provider", async () => {
    const primary = googleSession([standup]);
    const linked = googleSession([standup]);
    const outlook = googleSession([standup]);
    h.connectPrimaryCalendar.mockResolvedValue(primary.session);
    h.connectLinkedCalendars.mockResolvedValue([
      { session: linked.session, id: "lc1", email: "me@work.example" },
      { session: { ...outlook.session, provider: "OUTLOOK" }, id: "lc2", email: "o@x.example" },
    ]);
    await runCoAttendanceForUser("u1", { includeLinked: true }, NOW);
    expect(primary.listMeetingAttendees).toHaveBeenCalledTimes(1);
    expect(linked.listMeetingAttendees).toHaveBeenCalledTimes(1);
    expect(outlook.listMeetingAttendees).not.toHaveBeenCalled();
    expect(counters()["ana@client.example"]?.meetingCount).toBe(1);
  });

  it("connects nothing for a source whose interval has not passed", async () => {
    h.connectPrimaryCalendar.mockResolvedValue(googleSession([standup]).session);
    h.connectLinkedCalendars.mockResolvedValue([]);
    await runCoAttendanceForUser("u1", { includeLinked: false }, NOW);
    expect(h.connectPrimaryCalendar).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    await runCoAttendanceForUser("u1", { includeLinked: false }, new Date(NOW.getTime() + 60_000));
    expect(h.connectPrimaryCalendar).not.toHaveBeenCalled();
    expect(h.connectLinkedCalendars).not.toHaveBeenCalled();
  });

  it("does not let a hung pass hold up the next source", async () => {
    const hung = googleSession([standup]);
    hung.listMeetingAttendees.mockImplementation(() => new Promise(() => {}));
    const linked = googleSession([standup]);
    h.connectPrimaryCalendar.mockResolvedValue(hung.session);
    h.connectLinkedCalendars.mockResolvedValue([
      { session: linked.session, id: "lc1", email: "me@work.example" },
    ]);
    await runCoAttendanceForUser("u1", { includeLinked: true }, NOW, { passTimeoutMs: 20 });
    expect(linked.listMeetingAttendees).toHaveBeenCalledTimes(1);
  });

  it("runs queued users one at a time, each once while queued, and never throws", async () => {
    let running = 0;
    let peak = 0;
    h.connectPrimaryCalendar.mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      throw new Error("token refresh failed");
    });
    seed({
      user: [
        { id: "u1", email: "me@example.com" },
        { id: "u2", email: "b@example.com" },
      ],
      userToken: [
        { id: "t1", userId: "u1", provider: "google", accessToken: "x" },
        { id: "t2", userId: "u2", provider: "google", accessToken: "y" },
      ],
    });
    enqueueCoAttendance("u1", { includeLinked: false });
    enqueueCoAttendance("u1", { includeLinked: false });
    enqueueCoAttendance("u2", { includeLinked: false });
    await _drainCoAttendanceQueueForTests();
    expect(h.connectPrimaryCalendar.mock.calls.map((c) => c[0])).toEqual(["u1", "u2"]);
    expect(peak).toBe(1);
  });
});

describe("wiring", () => {
  it("the request-path syncs (POST /sync, login) and the linked row sync never list attendees", async () => {
    const { session, listMeetingAttendees } = googleSession([standup]);
    expect(await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW)).toBe(1);
    await syncLinkedCalendarWindow(session, "u1", "lc1", ZONE, NOW);
    h.connectLinkedCalendars.mockResolvedValue([{ session, id: "lc1", email: "me@work.example" }]);
    await syncLinkedCalendars("u1", NOW);
    expect(listMeetingAttendees).not.toHaveBeenCalled();
    expect(tables().contactCoAttendance ?? []).toEqual([]);
  });

  it("only the scheduler queues the job, after the calendar step, without awaiting it", () => {
    const scheduler = readFileSync(join(srcDir, "automation-scheduler.ts"), "utf8");
    const enqueue = scheduler.indexOf("enqueueCoAttendance(config.userId");
    expect(enqueue).toBeGreaterThan(scheduler.indexOf("await syncLinkedCalendars(config.userId)"));
    expect(scheduler.slice(enqueue - 20, enqueue)).not.toContain("await");
    const callersOf = (fn: string) =>
      sourceFiles(srcDir)
        .filter((file) => new RegExp(`\\b${fn}\\(`).test(readFileSync(file, "utf8")))
        .map((file) => relative(srcDir, file))
        .sort();
    expect(callersOf("enqueueCoAttendance")).toEqual([
      "automation-scheduler.ts",
      "pim/coattendance/coattendance-job.ts",
    ]);
    expect(callersOf("runCoAttendanceForUser")).toEqual(["pim/coattendance/coattendance-job.ts"]);
    expect(callersOf("countCoAttendance")).toEqual([
      "pim/coattendance/coattendance-job.ts",
      "pim/coattendance/coattendance-sync.ts",
    ]);
    expect(callersOf("syncLinkedCalendars")).toEqual([
      "automation-scheduler.ts",
      "pim/calendar-sync.ts",
    ]);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}
