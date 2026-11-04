import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real-Postgres proof of the co-attendance reader's gate (judge/v3/
// relationship-coattendance.ts, doc §3(2)): the source rows it reads are exactly
// the store's (the primary google UserToken, every GOOGLE LinkedCalendarAccount),
// any other calendar provider fails it, and every read is scoped to the one user.
// Skipped unless KLORN_TEST_PG_URL points at a database with every migration
// applied; DATABASE_URL is set to the same URL because setup.ts loads db.ts first.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

import { prisma } from "../db.js";
import { loadRelationshipSnapshot } from "../judge/v3/relationship-loader.js";
import { utcDayOf } from "../pim/coattendance/coattendance-rules.js";

const describePg = url ? describe : describe.skip;
const created: string[] = [];
const DAY_MS = 24 * 60 * 60 * 1000;
// Far from every edge (watermark lag 2, full window 30), so a run that crosses
// UTC midnight reads the same.
const today = utcDayOf(new Date());
const daysAgo = (n: number) => new Date(today.getTime() - n * DAY_MS);
const iso = (d: Date) => d.toISOString();

async function newUser(watermark: Date | null = daysAgo(1)): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `coatt-reader-${randomUUID()}@test.local`,
      coAttendanceCountedThrough: watermark,
    },
  });
  created.push(user.id);
  return user.id;
}

const primary = (userId: string, observedSince: Date | null, googleEmail?: string) =>
  prisma.userToken.create({
    data: {
      userId,
      provider: "google",
      accessToken: "enc",
      googleEmail,
      coAttendanceObservedSince: observedSince,
      coAttendanceLastPassAt: new Date(),
    },
  });

const linked = (
  userId: string,
  provider: "GOOGLE" | "OUTLOOK" | "ICLOUD" | "NAVER" | "DEVICE",
  observedSince: Date | null = null,
  needsReconnect = false,
) =>
  prisma.linkedCalendarAccount.create({
    data: {
      userId,
      provider,
      email: `${provider.toLowerCase()}-${randomUUID()}@test.local`,
      needsReconnect,
      coAttendanceObservedSince: observedSince,
      coAttendanceLastPassAt: provider === "GOOGLE" ? new Date() : null,
    },
  });

const counted = (userId: string, contactEmail: string) =>
  prisma.contactCoAttendance.create({
    data: {
      userId,
      contactEmail,
      meetingCount: 4,
      smallMeetingCount: 1,
      firstMetAt: daysAgo(20),
      lastMetAt: daysAgo(3),
    },
  });

const load = (userId: string, senderAddress = "Kim <kim@partner.io>") =>
  loadRelationshipSnapshot({ userId, senderAddress, userAddresses: ["me@acme.test"] });

beforeEach(() => {
  vi.stubEnv("CALENDAR_COATTENDANCE_ENABLED", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (!url) return;
  await prisma.user.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

describePg("co-attendance reader against Postgres", () => {
  it("every Google source covers the window: the row's counts, 0 for no row", async () => {
    const userId = await newUser();
    await primary(userId, daysAgo(45));
    await linked(userId, "GOOGLE", daysAgo(40));
    await counted(userId, "kim@partner.io");

    expect(await load(userId)).toMatchObject({
      meetingCount: 4,
      smallMeetingCount: 1,
      lastMetAt: iso(daysAgo(3)),
      coAttendanceObservedSince: iso(daysAgo(40)),
      coAttendanceCountedThrough: iso(daysAgo(1)),
      coAttendanceNext14d: null,
    });
    expect(await load(userId, "lee@partner.io")).toMatchObject({
      meetingCount: 0,
      smallMeetingCount: 0,
      lastMetAt: null,
    });
  });

  it("probe A: a Google calendar linked later (observed since yesterday) makes it unknown", async () => {
    const userId = await newUser();
    await primary(userId, daysAgo(45));
    await linked(userId, "GOOGLE", daysAgo(1));
    await counted(userId, "kim@partner.io");
    expect(await load(userId)).toMatchObject({
      meetingCount: null,
      coAttendanceObservedSince: null,
    });
  });

  it("probe C: a watermark 3 days old makes it unknown, though the last passes are fresh", async () => {
    const userId = await newUser(daysAgo(3));
    await primary(userId, daysAgo(45));
    await counted(userId, "kim@partner.io");
    expect((await load(userId)).meetingCount).toBeNull();
  });

  it("a Google source awaiting a reconnect makes it unknown", async () => {
    const userId = await newUser();
    await primary(userId, daysAgo(45));
    await linked(userId, "GOOGLE", daysAgo(40), true);
    expect((await load(userId)).meetingCount).toBeNull();
  });

  it.each([
    "OUTLOOK",
    "ICLOUD",
    "NAVER",
    "DEVICE",
  ] as const)("a %s calendar (not counted by the store) makes it unknown", async (provider) => {
    const userId = await newUser();
    await primary(userId, daysAgo(45));
    await linked(userId, provider);
    await counted(userId, "kim@partner.io");
    expect((await load(userId)).meetingCount).toBeNull();
  });

  it("reads only the user's own rows: another user's sources and counts change nothing", async () => {
    const userId = await newUser();
    await primary(userId, daysAgo(45));
    const other = await newUser(daysAgo(10));
    await primary(other, daysAgo(1));
    await linked(other, "OUTLOOK");
    await linked(other, "GOOGLE", null, true);
    await counted(other, "kim@partner.io");

    expect(await load(userId)).toMatchObject({ meetingCount: 0, lastMetAt: null });
    expect((await load(other)).meetingCount).toBeNull();
  });

  // Condition 6 uses the store's own-address set (loadOwnAddresses), not the
  // caller's list (User.email and linked inboxes): the store never counts these.
  it("the sender is the user's Google login (UserToken.googleEmail): unknown", async () => {
    const userId = await newUser();
    await primary(userId, daysAgo(45), "kim@partner.io");
    expect(await load(userId, "lee@partner.io")).toMatchObject({ meetingCount: 0 });
    expect(await load(userId)).toMatchObject({ meetingCount: null, lastMetAt: null });
  });

  it("the sender is a calendar-only linked account of the user: unknown", async () => {
    const userId = await newUser();
    await primary(userId, daysAgo(45));
    await prisma.linkedCalendarAccount.create({
      data: {
        userId,
        provider: "GOOGLE",
        email: "kim@partner.io",
        coAttendanceObservedSince: daysAgo(40),
        coAttendanceLastPassAt: new Date(),
      },
    });
    expect(await load(userId, "lee@partner.io")).toMatchObject({ meetingCount: 0 });
    expect(await load(userId)).toMatchObject({ meetingCount: null, lastMetAt: null });
  });

  it("a user with no Google calendar is unknown, even with a fresh watermark", async () => {
    const userId = await newUser();
    expect((await load(userId)).meetingCount).toBeNull();
  });
});
