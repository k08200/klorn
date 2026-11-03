/**
 * Per-contact co-attendance counts (founder decision 2026-11-01): from ended
 * meetings, keep only how many meetings the user shared with each address, how
 * many were small, and the first and last UTC day; never an attendee list. Behind
 * CALENDAR_COATTENDANCE_ENABLED (off by default): off, nothing is listed, read or
 * written.
 *
 * One pass per user, over every Google calendar source together: each finished
 * UTC day after the user's watermark (User.coAttendanceCountedThrough) is
 * evaluated exactly once, all sources' meetings of a day written in one
 * transaction. The watermark only advances through days every source listed in
 * full; each source's coAttendanceObservedSince is the first full day it was
 * covered, so readers can tell a true 0 from unknown.
 *
 * The rows live in the strict fake database, so every query is checked against
 * the real schema and every write is recorded. Transaction ids (xmin) are proven
 * on Postgres in calendar-coattendance-pg.test.ts.
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
  COATTENDANCE_PASS_INTERVAL_MS,
  runCoAttendancePass,
} from "../pim/coattendance/coattendance-sync.js";
import { DataWipeFenceError } from "../privacy/data-wipe-fence.js";

const FLAG = "CALENDAR_COATTENDANCE_ENABLED";
const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Today is 2026-11-01 (UTC): yesterday 10-31, and the 30-day window starts 10-02. */
const NOW = new Date("2026-11-01T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const ZONE = "Asia/Seoul";
const ATTENDEE_EMAILS = ["ana@client.example", "bo@client.example", "cy@vendor.example"];

type Rows = Record<string, Array<Record<string, unknown>>>;
let db: FakeDb;
const tables = () => db.tables as Rows;
const saved = process.env[FLAG];
const at = (iso: string) => new Date(iso);
const day = (iso: string) => at(`${iso}T00:00:00.000Z`);
const isMidnight = (value: unknown) => value instanceof Date && value.getTime() % DAY_MS === 0;

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

function googleSession(meetings: ProviderMeeting[], cut: Date | null = null) {
  const listMeetingAttendees = vi.fn(async () => ({
    meetings,
    truncated: cut !== null,
    lastStart: cut ?? meetings.at(-1)?.startTime ?? null,
  }));
  const session = {
    provider: "GOOGLE",
    listEvents: vi.fn(async () => [upcoming("up-1")]),
    listMeetingAttendees,
  } as unknown as CalendarSession;
  return { session, listMeetingAttendees };
}

/** The primary calendar lists `primary`; lc1 (if given) lists `linked`. */
function sources(primary: ProviderMeeting[], linked?: ProviderMeeting[]) {
  const p = googleSession(primary);
  const l = googleSession(linked ?? []);
  h.connectPrimaryCalendar.mockResolvedValue(p.session);
  h.connectLinkedCalendars.mockResolvedValue(
    linked ? [{ session: l.session, id: "lc1", email: "me@work.example" }] : [],
  );
  return { primary: p, linked: l };
}

const pass = (now = NOW, includeLinked = true) => runCoAttendancePass("u1", { includeLinked }, now);

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

const user = () => tables().user?.find((r) => r.id === "u1");
const token = () => tables().userToken?.find((r) => r.id === "t1");
const linkedRow = (id: string) => tables().linkedCalendarAccount?.find((r) => r.id === id);
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
    const { primary } = sources([standup]);
    expect(await pass()).toBeNull();
    enqueueCoAttendance("u1", { includeLinked: true });
    await _drainCoAttendanceQueueForTests();
    expect(primary.listMeetingAttendees).not.toHaveBeenCalled();
    expect(h.connectPrimaryCalendar).not.toHaveBeenCalled();
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
  it("lists the window's finished days and counts each contact of each ended meeting", async () => {
    const { primary } = sources([standup, allHands]);
    expect(await pass()).toMatchObject({ meetings: 2, contacts: 7 });
    // From the first second of the window's first day to today's midnight.
    expect(primary.listMeetingAttendees).toHaveBeenCalledWith({
      timeMin: "2026-10-01T23:59:59.000Z",
      timeMax: "2026-11-01T00:00:00.000Z",
    });
    expect(counters()).toMatchObject({
      "ana@client.example": {
        meetingCount: 2,
        smallMeetingCount: 1,
        firstMetAt: day("2026-10-28"),
        lastMetAt: day("2026-10-30"),
      },
      "bo@client.example": { meetingCount: 1, smallMeetingCount: 1 },
      "cy@vendor.example": { meetingCount: 1, smallMeetingCount: 0 },
    });
    const counted = Object.keys(counters());
    for (const own of ["me@example.com", "me@work.example", "me@gmail.com", "me@side.example"]) {
      expect(counted).not.toContain(own);
    }
    expect(counted).toHaveLength(7);
  });

  it("dates a meeting by the day it ended, also across midnight", async () => {
    const late = {
      ...meeting("ical:late@google.com|", "2026-10-29T23:30:00.000Z", [
        me,
        person("ana@x.example"),
      ]),
      endTime: at("2026-10-30T00:30:00.000Z"),
    };
    sources([late]);
    await pass();
    expect(counters()["ana@x.example"]).toMatchObject({
      firstMetAt: day("2026-10-30"),
      lastMetAt: day("2026-10-30"),
    });
  });

  it("counts nothing from a meeting the user declined, and writes no marker for it", async () => {
    const declined = meeting("ical:declined@google.com|", "2026-10-29T01:00:00.000Z", [
      { ...me, responseStatus: "declined" },
      person("ana@client.example"),
    ]);
    sources([declined]);
    expect(await pass()).toMatchObject({ meetings: 0, contacts: 0 });
    expect(tables().contactCoAttendance ?? []).toEqual([]);
    expect(tables().coAttendanceMeeting ?? []).toEqual([]);
  });

  it("reads no own addresses when the window has no meetings", async () => {
    sources([]);
    await pass();
    expect(db.reads).not.toContain("linkedInboxAccount");
  });

  it("never lists an Outlook, CalDAV or re-link-pending calendar", async () => {
    seed({
      linkedCalendarAccount: [
        { id: "lc1", userId: "u1", email: "me@work.example", needsReconnect: true },
        { id: "lc2", userId: "u1", provider: "OUTLOOK", email: "me@outlook.example" },
      ],
    });
    const outlook = googleSession([standup]);
    const { primary } = sources([standup]);
    h.connectLinkedCalendars.mockResolvedValue([
      { session: { ...outlook.session, provider: "OUTLOOK" }, id: "lc2", email: "o@x.example" },
    ]);
    await pass();
    expect(primary.listMeetingAttendees).toHaveBeenCalledTimes(1);
    expect(outlook.listMeetingAttendees).not.toHaveBeenCalled();
    expect(h.connectLinkedCalendars).not.toHaveBeenCalled();
  });
});

describe("watermark: each finished UTC day evaluated once", () => {
  it("the first pass covers the window through yesterday and records it", async () => {
    sources([standup], [allHands]);
    await pass();
    expect(user()?.coAttendanceCountedThrough).toEqual(day("2026-10-31"));
    for (const row of [token(), linkedRow("lc1")]) {
      expect(row).toMatchObject({
        coAttendanceObservedSince: day("2026-10-02"),
        coAttendanceLastPassAt: NOW,
      });
    }
    expect(linkedRow("lc2")).toMatchObject({ coAttendanceObservedSince: null });
  });

  it("lists only the days after the watermark, and nothing once yesterday is covered", async () => {
    const { primary } = sources([standup]);
    await pass();
    expect(await pass(new Date(NOW.getTime() + COATTENDANCE_PASS_INTERVAL_MS))).toBeNull();
    expect(primary.listMeetingAttendees).toHaveBeenCalledTimes(1);
    const tomorrow = at("2026-11-02T07:00:00.000Z");
    await pass(tomorrow);
    expect(primary.listMeetingAttendees).toHaveBeenLastCalledWith({
      timeMin: "2026-10-31T23:59:59.000Z",
      timeMax: "2026-11-02T00:00:00.000Z",
    });
    expect(user()?.coAttendanceCountedThrough).toEqual(day("2026-11-01"));
    expect(token()?.coAttendanceObservedSince).toEqual(day("2026-10-02"));
  });

  it("counts a meeting that ended today only after the day is over", async () => {
    const today = meeting("ical:today@google.com|", "2026-11-01T08:00:00.000Z", [
      me,
      person("ana@client.example"),
    ]);
    sources([today]);
    expect(await pass()).toMatchObject({ meetings: 0 });
    expect(await pass(at("2026-11-02T07:00:00.000Z"))).toMatchObject({ meetings: 1 });
    expect(counters()["ana@client.example"]?.lastMetAt).toEqual(day("2026-11-01"));
  });

  it("never counts a meeting accepted after its day was evaluated", async () => {
    const before = meeting("ical:late-yes@google.com|", "2026-10-30T01:00:00.000Z", [
      { ...me, responseStatus: "needsAction" },
      person("ana@client.example"),
    ]);
    sources([before]);
    await pass();
    expect(counters()).toEqual({});
    // Accepted later: a listing that still returns it does not reopen 10-30.
    const accepted = { ...before, attendees: [me, person("ana@client.example")] };
    sources([accepted]);
    await pass(at("2026-11-02T07:00:00.000Z"));
    expect(counters()).toEqual({});
  });

  it("does not evaluate again a day that already has a marker (a pass that died midway)", async () => {
    seed({
      coAttendanceMeeting: [
        {
          id: "m1",
          userId: "u1",
          provider: "GOOGLE",
          eventKey: eventKeyOf("ical:done@google.com|"),
          endedAt: day("2026-10-30"),
        },
      ],
    });
    sources([standup, allHands]);
    await pass();
    // standup (10-30) is skipped with its day; allHands (10-28) is counted.
    expect(counters()["bo@client.example"]).toBeUndefined();
    expect(counters()["cy@vendor.example"]?.meetingCount).toBe(1);
  });

  it("a cut listing advances neither the watermark nor observed-since past its last full day", async () => {
    const p = googleSession([allHands], at("2026-10-20T05:00:00.000Z"));
    const l = googleSession([standup]);
    h.connectPrimaryCalendar.mockResolvedValue(p.session);
    h.connectLinkedCalendars.mockResolvedValue([{ session: l.session, id: "lc1", email: "w" }]);
    await pass();
    // The primary stopped inside 10-20, so 10-19 is the last day both listed in full.
    expect(user()?.coAttendanceCountedThrough).toEqual(day("2026-10-19"));
    expect(counters()).toEqual({});
    expect(token()?.coAttendanceObservedSince).toEqual(day("2026-10-02"));
    // The pass time is the reader's freshness guard: never written for a cut listing.
    expect(token()?.coAttendanceLastPassAt).toBeNull();
    expect(linkedRow("lc1")?.coAttendanceLastPassAt).toEqual(NOW);

    // A cut inside the first day covers nothing: no watermark, no observed-since.
    seed();
    const cutEarly = googleSession([allHands], at("2026-10-02T03:00:00.000Z"));
    h.connectPrimaryCalendar.mockResolvedValue(cutEarly.session);
    h.connectLinkedCalendars.mockResolvedValue([]);
    await pass();
    expect(user()?.coAttendanceCountedThrough).toBeNull();
    expect(token()?.coAttendanceObservedSince).toBeNull();
    expect(token()?.coAttendanceLastPassAt).toBeNull();
  });

  it("with one source failing, only the other's pass time is written, and nothing advances", async () => {
    const { primary, linked } = sources([standup], [allHands]);
    primary.listMeetingAttendees.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await pass()).toBeNull();
    expect(token()?.coAttendanceLastPassAt).toBeNull();
    expect(linkedRow("lc1")?.coAttendanceLastPassAt).toEqual(NOW);
    expect(user()?.coAttendanceCountedThrough).toBeNull();
    expect(token()?.coAttendanceObservedSince).toBeNull();
    expect(linkedRow("lc1")?.coAttendanceObservedSince).toBeNull();
    expect(counters()).toEqual({});
    expect(linked.listMeetingAttendees).toHaveBeenCalledTimes(1);
  });

  it("a failed source holds the watermark for every source, and backs off", async () => {
    const { primary, linked } = sources([standup], [allHands]);
    linked.listMeetingAttendees.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await pass()).toBeNull();
    expect(user()?.coAttendanceCountedThrough).toBeNull();
    expect(counters()).toEqual({});
    expect(token()?.coAttendanceObservedSince).toBeNull();
    expect(linkedRow("lc1")?.coAttendanceLastPassAt).toBeNull();
    const soon = new Date(NOW.getTime() + COATTENDANCE_FAILURE_BACKOFF_MS - 1);
    expect(await pass(soon)).toBeNull();
    expect(primary.listMeetingAttendees).toHaveBeenCalledTimes(1);
    const after = new Date(NOW.getTime() + COATTENDANCE_FAILURE_BACKOFF_MS);
    expect(await pass(after)).toMatchObject({ meetings: 2 });
    expect(user()?.coAttendanceCountedThrough).toEqual(day("2026-10-31"));
  });

  it("restarts coverage after a gap: watermark to the window, every observed-since to its start", async () => {
    seed({
      user: [{ id: "u1", email: "me@example.com", coAttendanceCountedThrough: day("2026-09-20") }],
      userToken: [
        {
          id: "t1",
          userId: "u1",
          provider: "google",
          accessToken: "x",
          coAttendanceObservedSince: day("2026-08-01"),
          coAttendanceLastPassAt: day("2026-09-21"),
        },
      ],
      linkedCalendarAccount: [
        {
          id: "lc1",
          userId: "u1",
          email: "w@x.example",
          coAttendanceObservedSince: day("2026-08-01"),
        },
      ],
    });
    sources([standup], [allHands]);
    await pass();
    expect(user()?.coAttendanceCountedThrough).toEqual(day("2026-10-31"));
    expect(token()?.coAttendanceObservedSince).toEqual(day("2026-10-02"));
    expect(linkedRow("lc1")?.coAttendanceObservedSince).toEqual(day("2026-10-02"));
  });

  it("a gap is recorded even when the pass then fails, so no stale observed-since remains", async () => {
    seed({
      user: [{ id: "u1", email: "me@example.com", coAttendanceCountedThrough: day("2026-09-20") }],
      userToken: [
        {
          id: "t1",
          userId: "u1",
          provider: "google",
          accessToken: "x",
          coAttendanceObservedSince: day("2026-08-01"),
        },
      ],
    });
    const { primary } = sources([standup]);
    primary.listMeetingAttendees.mockRejectedValueOnce(new Error("socket hang up"));
    await pass();
    expect(user()?.coAttendanceCountedThrough).toEqual(day("2026-10-01"));
    expect(token()?.coAttendanceObservedSince).toBeNull();
  });

  it("a newly linked calendar is observed from the day after the watermark", async () => {
    seed({
      user: [{ id: "u1", email: "me@example.com", coAttendanceCountedThrough: day("2026-10-30") }],
      userToken: [
        {
          id: "t1",
          userId: "u1",
          provider: "google",
          accessToken: "x",
          coAttendanceObservedSince: day("2026-10-02"),
          coAttendanceLastPassAt: at("2026-10-31T01:00:00.000Z"),
        },
      ],
      linkedCalendarAccount: [{ id: "lc1", userId: "u1", email: "w@x.example" }],
    });
    sources([], []);
    await pass();
    expect(user()?.coAttendanceCountedThrough).toEqual(day("2026-10-31"));
    expect(linkedRow("lc1")?.coAttendanceObservedSince).toEqual(day("2026-10-31"));
    expect(token()?.coAttendanceObservedSince).toEqual(day("2026-10-02"));
  });

  it("a source left out of an advance (re-link pending, linked sync off) loses observed-since", async () => {
    seed({
      linkedCalendarAccount: [
        {
          id: "lc1",
          userId: "u1",
          email: "w@x.example",
          needsReconnect: true,
          coAttendanceObservedSince: day("2026-10-02"),
        },
      ],
    });
    sources([standup]);
    await pass();
    expect(linkedRow("lc1")?.coAttendanceObservedSince).toBeNull();
    expect(token()?.coAttendanceObservedSince).toEqual(day("2026-10-02"));
  });

  it("re-linking or reconnecting a Google calendar clears both source markers", () => {
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

describe("idempotency", () => {
  it("counts a meeting once when it sits in the primary and a linked calendar", async () => {
    sources([standup], [standup]);
    await pass();
    expect(counters()["ana@client.example"]?.meetingCount).toBe(1);
    expect(tables().coAttendanceMeeting).toHaveLength(1);
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

  it("forgets markers older than the window, never one of a day it can still evaluate", async () => {
    seed({
      coAttendanceMeeting: [
        {
          id: "m-old",
          userId: "u1",
          provider: "GOOGLE",
          eventKey: "a".repeat(64),
          endedAt: day("2026-09-30"),
        },
        {
          id: "m-edge",
          userId: "u1",
          provider: "GOOGLE",
          eventKey: "b".repeat(64),
          endedAt: day("2026-10-01"),
        },
        {
          id: "m-in",
          userId: "u1",
          provider: "GOOGLE",
          eventKey: "c".repeat(64),
          endedAt: day("2026-10-02"),
        },
        {
          id: "m-other",
          userId: "u2",
          provider: "GOOGLE",
          eventKey: "d".repeat(64),
          endedAt: day("2026-09-30"),
        },
      ],
    });
    sources([]);
    await pass();
    expect(
      tables()
        .coAttendanceMeeting?.map((r) => r.id)
        .sort(),
    ).toEqual(["m-edge", "m-in", "m-other"]);
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
  const onDay = (meetings: CountedMeeting[], d: string): CountedMeeting[] =>
    meetings.map((m) => ({
      ...m,
      startTime: at(`${d}T01:00:00.000Z`),
      endTime: at(`${d}T02:00:00.000Z`),
    }));

  it("writes each UTC end-day in its own transaction, the whole day together", () => {
    const day1 = onDay(many(3, 2, "a"), "2026-10-20");
    const day2 = onDay(many(2, 2, "b"), "2026-10-21");
    const batches = planBatches([...day2, ...day1].reverse());
    expect(batches.map((b) => b.length)).toEqual([3, 2]);
  });

  it("groups a meeting by the day it ended, not the day it started", () => {
    const spanning = {
      ...many(1, 1, "s")[0],
      startTime: at("2026-10-20T23:30:00.000Z"),
      endTime: at("2026-10-21T00:30:00.000Z"),
    } as CountedMeeting;
    const next = onDay(many(1, 1, "n"), "2026-10-21");
    const before = onDay(many(1, 1, "b"), "2026-10-20");
    const batches = planBatches([spanning, ...next, ...before]);
    expect(batches.map((b) => b.map((m) => m.identity).sort())).toEqual([
      [before[0]?.identity],
      [next[0]?.identity, spanning.identity].sort(),
    ]);
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
    expect(MEETINGS_PER_TRANSACTION).toBe(25);
  });

  it("closes a batch before it would pass 200 distinct contacts", () => {
    expect(CONTACTS_PER_TRANSACTION).toBe(200);
    const batches = planBatches(many(10, 50, "w"));
    expect(batches.map((b) => b.length)).toEqual([4, 4, 2]);
  });
});

describe("no attendee data outside the counters", () => {
  it("writes counters, markers and coverage only; nothing finer than a day but the pass time", async () => {
    sources([standup, allHands], []);
    await pass();

    expect(Object.keys(db.writes).sort()).toEqual([
      "coAttendanceMeeting",
      "contactCoAttendance",
      "linkedCalendarAccount",
      "user",
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
    expect(JSON.stringify(db.writes.coAttendanceMeeting)).not.toContain("@");
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
    for (const write of db.writes.contactCoAttendance ?? []) {
      const stored = JSON.stringify([write.data, write.update]);
      expect(ATTENDEE_EMAILS.filter((e) => stored.includes(e)).length).toBeLessThanOrEqual(1);
      if (write.op === "update") expect(stored).not.toContain("@");
    }
    for (const write of db.writes.user ?? []) {
      expect(Object.keys(write.data ?? {})).toEqual(["coAttendanceCountedThrough"]);
    }
    expect(isMidnight(user()?.coAttendanceCountedThrough)).toBe(true);
  });

  it("puts no attendee data in the synced rows or in any log line", async () => {
    const { primary } = sources([standup, allHands]);
    await syncPrimaryCalendarWindow(primary.session, "u1", ZONE, NOW);
    await pass();
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

  it("a failure never throws, never logs what it carried, and is reported once until a pass succeeds", async () => {
    const { primary } = sources([standup]);
    primary.listMeetingAttendees.mockRejectedValue(
      Object.assign(new Error("Invalid upsert: contactEmail ana@client.example"), {
        code: "P2009",
      }),
    );
    expect(await pass()).toBeNull();
    expect(await pass(new Date(NOW.getTime() + COATTENDANCE_FAILURE_BACKOFF_MS))).toBeNull();
    expect(h.captureError).toHaveBeenCalledTimes(1);
    expect(h.captureError.mock.calls[0]?.[1]).toMatchObject({
      tags: { scope: "calendar.coattendance" },
    });
    expect(allLoggedText()).not.toContain("ana@client.example");
    expect(allLoggedText()).toContain("P2009");

    primary.listMeetingAttendees.mockResolvedValue({
      meetings: [],
      truncated: false,
      lastStart: null,
    });
    expect(
      await pass(new Date(NOW.getTime() + 2 * COATTENDANCE_FAILURE_BACKOFF_MS)),
    ).not.toBeNull();
    primary.listMeetingAttendees.mockRejectedValue(new Error("again"));
    await pass(at("2026-11-02T07:00:00.000Z"));
    expect(h.captureError).toHaveBeenCalledTimes(2);
  });

  it("logs a listing that timed out, without data, and lets the next pass run", async () => {
    const { primary } = sources([standup]);
    primary.listMeetingAttendees.mockImplementationOnce(() => new Promise(() => {}));
    expect(
      await runCoAttendancePass("u1", { includeLinked: true }, NOW, { listTimeoutMs: 20 }),
    ).toBeNull();
    expect(allLoggedText()).toContain("TimeoutError");
    const after = new Date(NOW.getTime() + COATTENDANCE_FAILURE_BACKOFF_MS);
    expect(await pass(after)).toMatchObject({ meetings: 1 });
  });

  it("does not report a write the data-wipe fence refused: the wipe is expected", async () => {
    const { primary } = sources([standup]);
    primary.listMeetingAttendees.mockRejectedValue(new DataWipeFenceError());
    expect(await pass()).toBeNull();
    expect(h.captureError).not.toHaveBeenCalled();
  });

  it("a counter write that fails rolls its day back and holds the watermark", async () => {
    sources([standup]);
    const original = db.model("contactCoAttendance").upsert;
    db.model("contactCoAttendance").upsert = () =>
      Promise.reject(new Error("write failed for bo@client.example"));
    await pass();
    expect(tables().coAttendanceMeeting ?? []).toEqual([]);
    expect(user()?.coAttendanceCountedThrough).toBeNull();
    expect(allLoggedText()).not.toContain("bo@client.example");

    db.model("contactCoAttendance").upsert = original;
    _resetCoAttendancePassesForTests();
    await pass();
    expect(counters()["bo@client.example"]?.meetingCount).toBe(1);
  });
});

describe("the scheduler's queue", () => {
  it("runs queued users one at a time, each once while queued, and never throws", async () => {
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
    let running = 0;
    let peak = 0;
    h.connectPrimaryCalendar.mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      throw new Error("token refresh failed");
    });
    h.connectLinkedCalendars.mockResolvedValue([]);
    enqueueCoAttendance("u1", { includeLinked: false });
    enqueueCoAttendance("u1", { includeLinked: false });
    enqueueCoAttendance("u2", { includeLinked: false });
    await _drainCoAttendanceQueueForTests();
    expect(h.connectPrimaryCalendar.mock.calls.map((c) => c[0])).toEqual(["u1", "u2"]);
    expect(peak).toBe(1);
  });
});

describe("wiring", () => {
  it("the request-path syncs and the linked row sync never list attendees", async () => {
    const { session, listMeetingAttendees } = googleSession([standup]);
    expect(await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW)).toBe(1);
    await syncLinkedCalendarWindow(session, "u1", "lc1", ZONE, NOW);
    h.connectLinkedCalendars.mockResolvedValue([{ session, id: "lc1", email: "me@work.example" }]);
    await syncLinkedCalendars("u1", NOW);
    expect(listMeetingAttendees).not.toHaveBeenCalled();
    expect(tables().contactCoAttendance ?? []).toEqual([]);
  });

  it("only the scheduler queues the pass, after the calendar step, without awaiting it", () => {
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
    expect(callersOf("runCoAttendancePass")).toEqual([
      "pim/coattendance/coattendance-job.ts",
      "pim/coattendance/coattendance-sync.ts",
    ]);
    expect(callersOf("countCoAttendance")).toEqual([]);
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
