import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// Real-Postgres proof of the co-attendance store (pim/coattendance/ and migration
// 20261101010000_calendar_coattendance). A mock cannot show what matters here:
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

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { prisma } from "../db.js";
import type { CountedMeeting } from "../pim/coattendance/coattendance-rules.js";
import { claimAndCount, eventKeyOf } from "../pim/coattendance/coattendance-store.js";
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
        ("id", "userId", "contactEmail", "meetingCount", "smallMeetingCount", "firstMetAt", "lastMetAt", "updatedAt")
      VALUES (${randomUUID()}, ${userId}, ${email}, 1, 0, now(), now(), now())`;
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
          ("id", "userId", "contactEmail", "meetingCount", "smallMeetingCount", "firstMetAt", "lastMetAt", "updatedAt")
        VALUES (${randomUUID()}, ${userId}, 'bo@x.example', 1, 2, now(), now(), now())`),
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

describePg("the data wipe", () => {
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
