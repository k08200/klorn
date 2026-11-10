import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// Real-Postgres proof of the co-attendance store (pim/coattendance/ and migration
// 20261103010000_calendar_coattendance). A mock cannot show what matters here:
// that the CHECKs refuse what they should, that a marker claim inserts once under
// concurrency, that Prisma's upsert on the compound key holds when two batches
// write the same contact at once, that the data-wipe fence trigger covers both
// tables, and that a wipe removes both. Skipped unless KLORN_TEST_PG_URL points at
// a database with every migration applied; set DATABASE_URL to the same URL, since
// setup.ts loads db.ts before this file runs.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

const h = vi.hoisted(() => ({ connectPrimaryCalendar: vi.fn(), connectLinkedCalendars: vi.fn() }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../pim/calendar-providers/dispatch.js", () => ({
  connectPrimaryCalendar: h.connectPrimaryCalendar,
  connectLinkedCalendars: h.connectLinkedCalendars,
}));

import { prisma } from "../db.js";
import type { MeetingAttendee, ProviderMeeting } from "../pim/calendar-providers/types.js";
import type { CountedMeeting } from "../pim/coattendance/coattendance-rules.js";
import {
  claimAndCount,
  eventKeyOf,
  recordCountedMeetings,
} from "../pim/coattendance/coattendance-store.js";
import { runCoAttendancePass } from "../pim/coattendance/coattendance-sync.js";
import { isDataWipeFenceError } from "../privacy/data-wipe-fence.js";
import { purgeUserData } from "../purge-user-data.js";

const describePg = url ? describe : describe.skip;
const created: string[] = [];

async function newUser(): Promise<string> {
  const user = await prisma.user.create({ data: { email: `coattend-${randomUUID()}@test.local` } });
  created.push(user.id);
  return user.id;
}

function meeting(id: string, start: string, contacts: string[], small = true): CountedMeeting {
  const startTime = new Date(start);
  return {
    identity: `ical:${id}|`,
    startTime,
    endTime: new Date(startTime.getTime() + 60 * 60 * 1000),
    contacts,
    small,
  };
}

const counter = (userId: string, contactEmail: string) =>
  prisma.contactCoAttendance.findUnique({
    where: { userId_contactEmail: { userId, contactEmail } },
  });

/** The SQLSTATE of a refused raw statement. */
async function sqlState(statement: Promise<unknown>): Promise<string | undefined> {
  const err = (await statement.then(
    () => null,
    (e: unknown) => e,
  )) as { meta?: { code?: string } } | null;
  return err?.meta?.code;
}

afterAll(async () => {
  if (!url) return;
  await prisma.user.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

describePg("the tables refuse what the code never writes", () => {
  it("refuses an address that is not trimmed and lower-cased", async () => {
    const userId = await newUser();
    const insert = (email: string) => prisma.$executeRaw`
      INSERT INTO "ContactCoAttendance"
        ("id", "userId", "contactEmail", "meetingCount", "smallMeetingCount", "firstMetAt", "lastMetAt")
      VALUES (${randomUUID()}, ${userId}, ${email}, 1, 0, current_date, current_date)`;
    expect(await sqlState(insert("Ana@Client.Example"))).toBe("23514");
    expect(await sqlState(insert(" ana@client.example"))).toBe("23514");
    await insert("ana@client.example");
    expect(await counter(userId, "ana@client.example")).not.toBeNull();
  });

  it("refuses more small meetings than meetings, and a marker key that is not a hash", async () => {
    const userId = await newUser();
    expect(
      await sqlState(prisma.$executeRaw`
        INSERT INTO "ContactCoAttendance"
          ("id", "userId", "contactEmail", "meetingCount", "smallMeetingCount", "firstMetAt", "lastMetAt")
        VALUES (${randomUUID()}, ${userId}, 'bo@x.example', 1, 2, current_date, current_date)`),
    ).toBe("23514");
    expect(
      await sqlState(prisma.$executeRaw`
        INSERT INTO "CoAttendanceMeeting" ("id", "userId", "provider", "eventKey", "endedAt")
        VALUES (${randomUUID()}, ${userId}, 'GOOGLE', 'ical:standup@google.com|', now())`),
    ).toBe("23514");
  });

  it("has row-level security on, with exactly the tenant and system policies", async () => {
    const rows = await prisma.$queryRaw<Array<{ relname: string; rls: boolean; policies: bigint }>>`
      SELECT c.relname, c.relrowsecurity AS rls,
             (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
      FROM pg_class c
      WHERE c.relname IN ('ContactCoAttendance', 'CoAttendanceMeeting')
      ORDER BY c.relname`;
    expect(rows.map((r) => [r.relname, r.rls, Number(r.policies)])).toEqual([
      ["CoAttendanceMeeting", true, 2],
      ["ContactCoAttendance", true, 2],
    ]);
  });
});

describePg("counting on a real database", () => {
  it("counts a meeting once when two passes claim it at the same time", async () => {
    const userId = await newUser();
    const batch = [
      meeting("m1", "2026-10-20T01:00:00Z", ["ana@client.example", "bo@client.example"]),
      meeting("m2", "2026-10-22T01:00:00Z", ["ana@client.example"], false),
    ];
    const results = await Promise.all([
      claimAndCount("GOOGLE", userId, batch),
      claimAndCount("GOOGLE", userId, batch),
      claimAndCount("GOOGLE", userId, batch),
    ]);
    expect(results.reduce((sum, n) => sum + n, 0)).toBe(2);
    expect(await counter(userId, "ana@client.example")).toMatchObject({
      meetingCount: 2,
      smallMeetingCount: 1,
      firstMetAt: new Date("2026-10-20T00:00:00Z"),
      lastMetAt: new Date("2026-10-22T00:00:00Z"),
    });
    expect(await counter(userId, "bo@client.example")).toMatchObject({ meetingCount: 1 });
    const markers = await prisma.coAttendanceMeeting.findMany({ where: { userId } });
    expect(markers.map((m) => m.eventKey).sort()).toEqual(
      [eventKeyOf("ical:m1|"), eventKeyOf("ical:m2|")].sort(),
    );
  });

  it("keeps every count when different meetings write the same contacts at once", async () => {
    const userId = await newUser();
    const contacts = ["ana@client.example", "bo@client.example", "cy@client.example"];
    const writers = Array.from({ length: 8 }, (_, i) =>
      claimAndCount("GOOGLE", userId, [
        // Reversed on odd writers: the store's address order must avoid a deadlock.
        meeting(`p${i}`, `2026-10-${10 + i}T01:00:00Z`, i % 2 ? [...contacts].reverse() : contacts),
      ]),
    );
    expect(await Promise.all(writers)).toEqual(Array(8).fill(1));
    for (const contact of contacts) {
      expect(await counter(userId, contact)).toMatchObject({
        meetingCount: 8,
        firstMetAt: new Date("2026-10-10T00:00:00Z"),
        lastMetAt: new Date("2026-10-17T00:00:00Z"),
      });
    }
  });

  it("moves first and last met outward only", async () => {
    const userId = await newUser();
    await claimAndCount("GOOGLE", userId, [
      meeting("mid", "2026-10-15T23:30:00Z", ["ana@x.example"]),
    ]);
    await claimAndCount("GOOGLE", userId, [
      meeting("early", "2026-10-01T09:00:00Z", ["ana@x.example"]),
    ]);
    await claimAndCount("GOOGLE", userId, [
      meeting("late", "2026-10-29T09:00:00Z", ["ana@x.example"]),
    ]);
    await claimAndCount("GOOGLE", userId, [
      meeting("inner", "2026-10-20T09:00:00Z", ["ana@x.example"]),
    ]);
    expect(await counter(userId, "ana@x.example")).toMatchObject({
      meetingCount: 4,
      firstMetAt: new Date("2026-10-01T00:00:00Z"),
      lastMetAt: new Date("2026-10-29T00:00:00Z"),
    });
  });
});

describePg("nothing finer than a day", () => {
  it("has no timestamp column but the three days, and stores only midnights in them", async () => {
    const userId = await newUser();
    await claimAndCount("GOOGLE", userId, [
      meeting("d1", "2026-10-20T13:47:21.123Z", ["ana@x.example", "bo@x.example"]),
      meeting("d2", "2026-10-21T23:59:59.999Z", ["ana@x.example"]),
    ]);
    const columns = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('ContactCoAttendance', 'CoAttendanceMeeting')
        AND data_type LIKE 'timestamp%'
      ORDER BY table_name, column_name`;
    expect(columns.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
      "CoAttendanceMeeting.endedAt",
      "ContactCoAttendance.firstMetAt",
      "ContactCoAttendance.lastMetAt",
    ]);
    const [finer] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT
        (SELECT count(*) FROM "ContactCoAttendance" WHERE "userId" = ${userId}
           AND ("firstMetAt" <> date_trunc('day', "firstMetAt") OR "lastMetAt" <> date_trunc('day', "lastMetAt")))
        + (SELECT count(*) FROM "CoAttendanceMeeting" WHERE "userId" = ${userId}
           AND "endedAt" <> date_trunc('day', "endedAt")) AS n`;
    expect(Number(finer?.n)).toBe(0);
    expect(await prisma.coAttendanceMeeting.count({ where: { userId } })).toBe(2);
  });
});

describePg("one transaction per UTC end-day", () => {
  /** The transaction that last wrote each contact's row, by address. */
  async function writers(userId: string): Promise<Record<string, string>> {
    const rows = await prisma.$queryRaw<Array<{ contactEmail: string; tx: string }>>`
      SELECT "contactEmail", xmin::text AS tx FROM "ContactCoAttendance" WHERE "userId" = ${userId}`;
    return Object.fromEntries(rows.map((r) => [r.contactEmail, r.tx]));
  }

  it("writes the meetings of one end-day in one transaction, and another day in another", async () => {
    const userId = await newUser();
    await recordCountedMeetings("GOOGLE", userId, [
      meeting("day1-a", "2026-10-20T01:00:00Z", ["ana@x.example"]),
      meeting("day2-a", "2026-10-21T01:00:00Z", ["cy@x.example"]),
      meeting("day1-b", "2026-10-20T15:00:00Z", ["bo@x.example"]),
    ]);
    const tx = await writers(userId);
    // Rows that share a transaction id reveal one day, which lastMetAt already says.
    expect(tx["ana@x.example"]).toBe(tx["bo@x.example"]);
    expect(tx["cy@x.example"]).not.toBe(tx["ana@x.example"]);
  });

  it("dates a midnight-spanning meeting by its end day, and writes it with that day only", async () => {
    const userId = await newUser();
    const spanning = {
      ...meeting("span", "2026-10-20T23:30:00Z", ["ana@x.example"]),
      endTime: new Date("2026-10-21T00:30:00Z"),
    };
    await recordCountedMeetings("GOOGLE", userId, [
      spanning,
      meeting("same-end-day", "2026-10-21T10:00:00Z", ["bo@x.example"]),
      meeting("start-day", "2026-10-20T10:00:00Z", ["cy@x.example"]),
    ]);
    const tx = await writers(userId);
    expect(tx["ana@x.example"]).toBe(tx["bo@x.example"]);
    expect(tx["ana@x.example"]).not.toBe(tx["cy@x.example"]);
    expect(await counter(userId, "ana@x.example")).toMatchObject({
      firstMetAt: new Date("2026-10-21T00:00:00Z"),
      lastMetAt: new Date("2026-10-21T00:00:00Z"),
    });
  });

  it("writes the primary's and a linked calendar's meetings of one day in one transaction", async () => {
    const userId = await newUser();
    await prisma.userToken.create({
      data: { userId, provider: "google", accessToken: "x" },
    });
    const linked = await prisma.linkedCalendarAccount.create({
      data: { userId, provider: "GOOGLE", email: `w-${randomUUID()}@x.example` },
    });
    const attendee = (email: string, extra = {}): MeetingAttendee => ({
      email,
      self: false,
      organizer: false,
      resource: false,
      responseStatus: "accepted",
      ...extra,
    });
    const listed = (id: string, contact: string): ProviderMeeting => ({
      identity: `ical:${id}|`,
      cancelled: false,
      allDay: false,
      startTime: new Date("2026-10-25T01:00:00Z"),
      endTime: new Date("2026-10-25T02:00:00Z"),
      attendeesOmitted: false,
      organizedBySelf: false,
      attendees: [attendee("me@self.example", { self: true }), attendee(contact)],
    });
    const session = (meetings: ProviderMeeting[]) => ({
      provider: "GOOGLE",
      listMeetingAttendees: async () => ({ meetings, truncated: false, lastStart: null }),
    });
    h.connectPrimaryCalendar.mockResolvedValue(session([listed("p", "pat@x.example")]));
    h.connectLinkedCalendars.mockResolvedValue([
      { id: linked.id, email: linked.email, session: session([listed("l", "lin@x.example")]) },
    ]);
    const saved = process.env.CALENDAR_COATTENDANCE_ENABLED;
    process.env.CALENDAR_COATTENDANCE_ENABLED = "true";
    try {
      const result = await runCoAttendancePass(
        userId,
        { includeLinked: true },
        new Date("2026-11-01T12:00:00Z"),
      );
      expect(result).toMatchObject({ meetings: 2 });
    } finally {
      if (saved === undefined) delete process.env.CALENDAR_COATTENDANCE_ENABLED;
      else process.env.CALENDAR_COATTENDANCE_ENABLED = saved;
    }
    const tx = await writers(userId);
    expect(tx["pat@x.example"]).toBeDefined();
    expect(tx["pat@x.example"]).toBe(tx["lin@x.example"]);
  });

  it("splits a day only past a cap: 26 meetings of one day take two transactions", async () => {
    const userId = await newUser();
    const day = Array.from({ length: 26 }, (_, i) =>
      meeting(`cap${i}`, "2026-10-22T01:00:00Z", [`p${i}@x.example`]),
    );
    expect(await recordCountedMeetings("GOOGLE", userId, day)).toMatchObject({ meetings: 26 });
    const tx = Object.values(await writers(userId));
    expect(new Set(tx).size).toBe(2);
  });
});

describePg("lock order", () => {
  it("claims the same meetings from opposite orders at once without a deadlock", async () => {
    const userId = await newUser();
    const batch = Array.from({ length: 10 }, (_, i) =>
      meeting(`o${i}`, `2026-10-${10 + i}T01:00:00Z`, ["ana@x.example", `p${i}@x.example`]),
    );
    const reversed = [...batch].reverse();
    const results = await Promise.all([
      claimAndCount("GOOGLE", userId, batch),
      claimAndCount("GOOGLE", userId, reversed),
      claimAndCount("GOOGLE", userId, batch),
      claimAndCount("GOOGLE", userId, reversed),
    ]);
    expect(results.reduce((sum, n) => sum + n, 0)).toBe(10);
    expect(await counter(userId, "ana@x.example")).toMatchObject({ meetingCount: 10 });
  });
});

/** Run a pass for `userId` whose primary calendar lists `meetings`, with the flag on. */
async function passWith(userId: string, meetings: ProviderMeeting[], now: Date) {
  h.connectPrimaryCalendar.mockResolvedValue({
    provider: "GOOGLE",
    listMeetingAttendees: async () => ({ meetings, truncated: false, lastStart: null }),
  });
  h.connectLinkedCalendars.mockResolvedValue([]);
  const saved = process.env.CALENDAR_COATTENDANCE_ENABLED;
  process.env.CALENDAR_COATTENDANCE_ENABLED = "true";
  try {
    return await runCoAttendancePass(userId, { includeLinked: true }, now);
  } finally {
    if (saved === undefined) delete process.env.CALENDAR_COATTENDANCE_ENABLED;
    else process.env.CALENDAR_COATTENDANCE_ENABLED = saved;
  }
}

function listedMeeting(id: string, start: string, contact: string): ProviderMeeting {
  const startTime = new Date(start);
  const person = (email: string, self = false): MeetingAttendee => ({
    email,
    self,
    organizer: false,
    resource: false,
    responseStatus: "accepted",
  });
  return {
    identity: `ical:${id}|`,
    cancelled: false,
    allDay: false,
    startTime,
    endTime: new Date(startTime.getTime() + 60 * 60 * 1000),
    attendeesOmitted: false,
    organizedBySelf: false,
    attendees: [person("me@self.example", true), person(contact)],
  };
}

const watermarkOf = async (userId: string) =>
  (await prisma.user.findUnique({ where: { id: userId } }))?.coAttendanceCountedThrough ?? null;

describePg("a split day resumes after a crash", () => {
  const NOW = new Date("2026-11-01T12:00:00Z");
  const splitDay = () =>
    Array.from({ length: 26 }, (_, i) =>
      listedMeeting(`split${i}`, "2026-10-25T01:00:00Z", `p${i}@x.example`),
    ).sort((a, b) => (eventKeyOf(a.identity) < eventKeyOf(b.identity) ? -1 : 1));

  it("counts the other slice of a 26-meeting day once, and only then advances the watermark", async () => {
    const userId = await newUser();
    await prisma.userToken.create({ data: { userId, provider: "google", accessToken: "x" } });
    const meetings = splitDay();
    // Slice 1 (13 meetings, in key order) committed; the pass died before slice 2.
    const firstSlice = meetings.slice(0, 13).map((m) => ({
      identity: m.identity,
      startTime: m.startTime as Date,
      endTime: m.endTime as Date,
      contacts: [m.attendees[1]?.email as string],
      small: true,
    }));
    expect(await claimAndCount("GOOGLE", userId, firstSlice)).toBe(13);
    expect(await watermarkOf(userId)).toBeNull();

    expect(await passWith(userId, meetings, NOW)).toMatchObject({ meetings: 13 });
    const rows = await prisma.contactCoAttendance.findMany({ where: { userId } });
    expect(rows).toHaveLength(26);
    expect(rows.every((r) => r.meetingCount === 1)).toBe(true);
    expect(await prisma.coAttendanceMeeting.count({ where: { userId } })).toBe(26);
    expect(await watermarkOf(userId)).toEqual(new Date("2026-10-31T00:00:00Z"));
  });

  it("a day transaction waits for another holding the user's lock", async () => {
    const userId = await newUser();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => {};
    const lockedSignal = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${0x0c0a7}::int, hashtext(${userId}))`;
        locked();
        await held;
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
    await lockedSignal;
    let done = false;
    const writer = claimAndCount("GOOGLE", userId, [
      {
        identity: "ical:waits|",
        startTime: new Date("2026-10-20T01:00:00Z"),
        endTime: new Date("2026-10-20T02:00:00Z"),
        contacts: ["ana@x.example"],
        small: true,
      },
    ]).then((n) => {
      done = true;
      return n;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(done).toBe(false);
    release();
    await holder;
    expect(await writer).toBe(1);
  });

  it("two writers of one split day at once count each meeting once (the per-user lock)", async () => {
    const userId = await newUser();
    const counted = splitDay().map((m) => ({
      identity: m.identity,
      startTime: m.startTime as Date,
      endTime: m.endTime as Date,
      contacts: [m.attendees[1]?.email as string],
      small: true,
    }));
    const results = await Promise.all([
      recordCountedMeetings("GOOGLE", userId, counted),
      recordCountedMeetings("GOOGLE", userId, [...counted].reverse()),
    ]);
    expect(results.reduce((sum, r) => sum + r.meetings, 0)).toBe(26);
    const rows = await prisma.contactCoAttendance.findMany({ where: { userId } });
    expect(rows).toHaveLength(26);
    expect(rows.every((r) => r.meetingCount === 1)).toBe(true);
  });
});

describePg("the data wipe", () => {
  it("resets the watermark: after a reconnect the whole window is counted again", async () => {
    const userId = await newUser();
    const NOW = new Date("2026-11-01T12:00:00Z");
    const meetings = [
      listedMeeting("w-early", "2026-10-03T01:00:00Z", "ana@x.example"),
      listedMeeting("w-late", "2026-10-30T01:00:00Z", "bo@x.example"),
    ];
    await prisma.userToken.create({ data: { userId, provider: "google", accessToken: "x" } });
    expect(await passWith(userId, meetings, NOW)).toMatchObject({ meetings: 2 });
    expect(await watermarkOf(userId)).toEqual(new Date("2026-10-31T00:00:00Z"));

    await prisma.$transaction((tx) => purgeUserData(tx as never, userId), {
      maxWait: 10_000,
      timeout: 30_000,
    });
    expect(await watermarkOf(userId)).toBeNull();
    // Reconnect, then the next pass: the wiped window is counted again, in full.
    await prisma.userToken.create({ data: { userId, provider: "google", accessToken: "y" } });
    expect(await passWith(userId, meetings, NOW)).toMatchObject({ meetings: 2 });
    expect(await counter(userId, "ana@x.example")).toMatchObject({ meetingCount: 1 });
    expect(await counter(userId, "bo@x.example")).toMatchObject({ meetingCount: 1 });
    expect(await watermarkOf(userId)).toEqual(new Date("2026-10-31T00:00:00Z"));
  });

  it("the fence trigger refuses a pass while the account's wipe is pending", async () => {
    const userId = await newUser();
    await prisma.$executeRaw`
      INSERT INTO "DataWipe" ("userId", "requestedAt", "purgedAt", "fenceUntil", "updatedAt")
      VALUES (${userId}, now() AT TIME ZONE 'UTC', NULL, NULL, now() AT TIME ZONE 'UTC')`;
    const err = await claimAndCount("GOOGLE", userId, [
      meeting("w1", "2026-10-20T01:00:00Z", ["ana@x.example"]),
    ]).catch((e: unknown) => e);
    expect(isDataWipeFenceError(err)).toBe(true);
    expect(await prisma.coAttendanceMeeting.count({ where: { userId } })).toBe(0);
    expect(await prisma.contactCoAttendance.count({ where: { userId } })).toBe(0);
  });

  it("purgeUserData removes both tables, and deleting the user cascades", async () => {
    const wiped = await newUser();
    const deleted = await newUser();
    for (const userId of [wiped, deleted]) {
      await claimAndCount("GOOGLE", userId, [
        meeting("x", "2026-10-20T01:00:00Z", ["ana@x.example"]),
      ]);
    }
    await prisma.$transaction((tx) => purgeUserData(tx as never, wiped), {
      maxWait: 10_000,
      timeout: 30_000,
    });
    await prisma.user.delete({ where: { id: deleted } });
    for (const userId of [wiped, deleted]) {
      expect(await prisma.contactCoAttendance.count({ where: { userId } })).toBe(0);
      expect(await prisma.coAttendanceMeeting.count({ where: { userId } })).toBe(0);
    }
  });
});
