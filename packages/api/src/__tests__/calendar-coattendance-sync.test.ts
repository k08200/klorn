/**
 * Per-contact co-attendance counts (founder decision 2026-11-01): from ended
 * meetings, keep only how many meetings the user shared with each address, how
 * many were small, and the first and last; never an attendee list. Behind
 * CALENDAR_COATTENDANCE_ENABLED (off by default): off, nothing is listed, read or
 * written. Each meeting is counted once across repeated syncs and across the
 * user's calendars, through a marker that holds a hash of the meeting's identity
 * and its end, nothing more.
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
import { claimAndCount, eventKeyOf } from "../pim/coattendance/coattendance-store.js";
import {
  _resetCoAttendancePassesForTests,
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
    linkedCalendarAccount: [{ id: "lc1", userId: "u1", email: "Me@Work.Example" }],
    linkedInboxAccount: [{ id: "li1", userId: "u1", email: "me@side.example" }],
    ...extra,
  });
  h.db = db;
}

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
    expect(listMeetingAttendees).not.toHaveBeenCalled();
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
    const standupAt = new Date("2026-10-30T00:00:00.000Z");
    const allHandsAt = new Date("2026-10-28T00:00:00.000Z");
    expect(counters()).toMatchObject({
      "ana@client.example": {
        meetingCount: 2,
        smallMeetingCount: 1,
        firstMetAt: allHandsAt,
        lastMetAt: standupAt,
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
    expect(await countCoAttendance(session as never, "u1", "lc1", NOW)).toBeNull();
    expect(db.reads).toEqual([]);
    expect(db.writes).toEqual({});
  });
});

describe("idempotency", () => {
  it("never counts a meeting twice across repeated passes", async () => {
    const { session } = googleSession([standup, allHands]);
    await countCoAttendance(session, "u1", null, NOW);
    const first = counters();
    _resetCoAttendancePassesForTests();
    expect(await countCoAttendance(session, "u1", null, NOW)).toMatchObject({ meetings: 0 });
    const later = new Date(NOW.getTime() + COATTENDANCE_PASS_INTERVAL_MS);
    expect(await countCoAttendance(session, "u1", null, later)).toMatchObject({ meetings: 0 });
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
      firstMetAt: new Date("2026-10-10T00:00:00.000Z"),
      lastMetAt: new Date("2026-10-30T00:00:00.000Z"),
    });
  });

  it("a second claim of the same meeting (a concurrent pass) changes nothing", async () => {
    const counted = {
      identity: "ical:race@google.com|",
      startTime: new Date("2026-10-30T01:00:00.000Z"),
      endTime: new Date("2026-10-30T02:00:00.000Z"),
      contacts: ["ana@client.example"],
      small: true,
    };
    expect(await claimAndCount("GOOGLE", "u1", [counted])).toBe(1);
    expect(await claimAndCount("GOOGLE", "u1", [counted])).toBe(0);
    expect(counters()["ana@client.example"]?.meetingCount).toBe(1);
  });

  it("runs at most once per account per interval", async () => {
    const { session, listMeetingAttendees } = googleSession([standup]);
    await countCoAttendance(session, "u1", null, NOW);
    const soon = new Date(NOW.getTime() + COATTENDANCE_PASS_INTERVAL_MS - 1);
    expect(await countCoAttendance(session, "u1", null, soon)).toBeNull();
    expect(listMeetingAttendees).toHaveBeenCalledTimes(1);
    // Another account of the same user has its own interval.
    await countCoAttendance(session, "u1", "lc1", soon);
    expect(listMeetingAttendees).toHaveBeenCalledTimes(2);
  });

  it("forgets markers of meetings that ended before the window, keeps the others", async () => {
    const old = new Date(NOW.getTime() - (COATTENDANCE_LOOKBACK_DAYS + 2) * DAY_MS);
    const recent = new Date(NOW.getTime() - 3 * DAY_MS);
    seed({
      coAttendanceMeeting: [
        { id: "m-old", userId: "u1", provider: "GOOGLE", eventKey: "a".repeat(64), endedAt: old },
        {
          id: "m-new",
          userId: "u1",
          provider: "GOOGLE",
          eventKey: "b".repeat(64),
          endedAt: recent,
        },
        { id: "m-other", userId: "u2", provider: "GOOGLE", eventKey: "c".repeat(64), endedAt: old },
      ],
    });
    await countCoAttendance(googleSession([]).session, "u1", null, NOW);
    expect(
      tables()
        .coAttendanceMeeting?.map((r) => r.id)
        .sort(),
    ).toEqual(["m-new", "m-other"]);
  });
});

describe("no attendee data outside the counters", () => {
  it("writes only the counters and the markers, and markers hold no address", async () => {
    const { session } = googleSession([standup, allHands]);
    await countCoAttendance(session, "u1", null, NOW);

    expect(Object.keys(db.writes).sort()).toEqual(["coAttendanceMeeting", "contactCoAttendance"]);
    const markers = tables().coAttendanceMeeting ?? [];
    expect(markers.map((r) => Object.keys(r).sort())).toEqual(
      markers.map(() => ["countedAt", "endedAt", "eventKey", "id", "provider", "userId"]),
    );
    expect(markers.map((r) => r.eventKey).sort()).toEqual(
      [eventKeyOf(standup.identity), eventKeyOf(allHands.identity)].sort(),
    );
    for (const marker of markers) expect(marker.eventKey).toMatch(/^[0-9a-f]{64}$/);
    const markerText = JSON.stringify(db.writes.coAttendanceMeeting);
    expect(markerText).not.toContain("@");
    expect(markerText).not.toContain("standup");

    // A counter row is one address and numbers: no other attendee rides along.
    for (const row of tables().contactCoAttendance ?? []) {
      expect(Object.keys(row).sort()).toEqual([
        "contactEmail",
        "createdAt",
        "firstMetAt",
        "id",
        "lastMetAt",
        "meetingCount",
        "smallMeetingCount",
        "updatedAt",
        "userId",
      ]);
    }
    // What a write would store (create, update, data) names at most one address;
    // only a filter (`where`) may name several, and a filter stores nothing.
    for (const write of db.writes.contactCoAttendance ?? []) {
      const stored = JSON.stringify([write.data, write.update]);
      const mentioned = ATTENDEE_EMAILS.filter((e) => stored.includes(e));
      expect(mentioned.length).toBeLessThanOrEqual(1);
      if (write.op === "update") expect(stored).not.toContain("@");
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

describe("sync wiring", () => {
  it("the request-path syncs (POST /sync, login) never list attendees", async () => {
    const { session, listMeetingAttendees } = googleSession([standup]);
    expect(await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW)).toBe(1);
    await syncLinkedCalendarWindow(session, "u1", "lc1", ZONE, NOW);
    expect(listMeetingAttendees).not.toHaveBeenCalled();
    expect(tables().contactCoAttendance ?? []).toEqual([]);
  });

  it("the scheduler's linked sync counts each account after its rows, once across both", async () => {
    const primary = googleSession([standup]);
    const linked = googleSession([standup]);
    h.connectLinkedCalendars.mockResolvedValue([
      { session: linked.session, id: "lc1", email: "me@work.example" },
    ]);
    await countCoAttendance(primary.session, "u1", null, NOW);
    expect(await syncLinkedCalendars("u1", NOW)).toMatchObject({ accounts: 1, events: 1 });
    expect(linked.listMeetingAttendees).toHaveBeenCalledTimes(1);
    expect(counters()["ana@client.example"]?.meetingCount).toBe(1);
  });

  it("the scheduler counts the primary calendar right after its row sync, and nothing else calls it", () => {
    const src = (rel: string) => readFileSync(join(srcDir, rel), "utf8");
    const scheduler = src("automation-scheduler.ts");
    expect(scheduler).toMatch(
      /await syncPrimaryCalendarWindow\(session, config\.userId, userTimezone\);\s*(?:\/\/[^\n]*\n\s*)*await countCoAttendance\(session, config\.userId, null\);/,
    );
    const callers = sourceFiles(srcDir)
      .filter((file) => /\bcountCoAttendance\(/.test(readFileSync(file, "utf8")))
      .map((file) => relative(srcDir, file))
      .sort();
    expect(callers).toEqual([
      "automation-scheduler.ts",
      "pim/calendar-sync.ts",
      "pim/coattendance/coattendance-sync.ts",
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
