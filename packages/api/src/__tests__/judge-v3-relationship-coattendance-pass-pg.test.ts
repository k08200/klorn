import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Writer and reader together, against Postgres: the real co-attendance pass
// (pim/coattendance/coattendance-sync.ts) over fake Google calendar sessions,
// then the relationship reader's gate (judge/v3/relationship-coattendance.ts,
// doc §3(2)). Guards the false zeros the gate exists for: probe A (a calendar
// linked later) and probe C (a failing source freezes the watermark while the
// others' pass times stay fresh). Fixed dates on both sides, so nothing depends
// on the wall clock. Skipped unless KLORN_TEST_PG_URL points at a database with
// every migration applied.
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
import { loadRelationshipSnapshot } from "../judge/v3/relationship-loader.js";
import type { MeetingAttendee, ProviderMeeting } from "../pim/calendar-providers/types.js";
import {
  _resetCoAttendancePassesForTests,
  runCoAttendancePass,
} from "../pim/coattendance/coattendance-sync.js";

const describePg = url ? describe : describe.skip;
const created: string[] = [];
const DAY_MS = 24 * 60 * 60 * 1000;
/** The first pass runs on 2026-10-20 (UTC): its window starts 09-20, the watermark is 10-19. */
const D0 = new Date("2026-10-20T12:00:00Z");
const later = (days: number) => new Date(D0.getTime() + days * DAY_MS);
const day = (iso: string) => `${iso}T00:00:00.000Z`;

async function newUser(): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `coatt-pass-${randomUUID()}@test.local` },
  });
  created.push(user.id);
  await prisma.userToken.create({
    data: { userId: user.id, provider: "google", accessToken: "x" },
  });
  return user.id;
}

const linkCalendar = (userId: string) =>
  prisma.linkedCalendarAccount.create({
    data: { userId, provider: "GOOGLE", email: `cal-${randomUUID()}@x.example` },
  });

function meeting(id: string, start: string, contact: string): ProviderMeeting {
  const person = (email: string, self = false): MeetingAttendee => ({
    email,
    self,
    organizer: false,
    resource: false,
    responseStatus: "accepted",
  });
  const startTime = new Date(start);
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

const listing = (meetings: ProviderMeeting[]) => ({
  provider: "GOOGLE",
  listMeetingAttendees: async () => ({ meetings, truncated: false, lastStart: null }),
});
const failing = {
  provider: "GOOGLE",
  listMeetingAttendees: async () => {
    throw new Error("calendar unavailable");
  },
};

/** One pass at `now`: the primary lists `meetings`, each linked calendar its given session. */
function pass(
  userId: string,
  now: Date,
  meetings: ProviderMeeting[] = [],
  linkedSessions: { id: string; email: string; session: object }[] = [],
) {
  h.connectPrimaryCalendar.mockResolvedValue(listing(meetings));
  h.connectLinkedCalendars.mockResolvedValue(linkedSessions);
  return runCoAttendancePass(userId, { includeLinked: true }, now);
}

const read = (userId: string, now: Date, sender = "Pat <pat@x.example>") =>
  loadRelationshipSnapshot({ userId, senderAddress: sender, userAddresses: [], now });

const watermarkOf = async (userId: string) =>
  (await prisma.user.findUnique({ where: { id: userId } }))?.coAttendanceCountedThrough ?? null;

beforeEach(() => {
  vi.stubEnv("CALENDAR_COATTENDANCE_ENABLED", "true");
  _resetCoAttendancePassesForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (!url) return;
  await prisma.user.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

describePg("co-attendance: the real pass, then the reader", () => {
  it("first pass: a met contact reads its count, an unmet sender reads 0", async () => {
    const userId = await newUser();
    expect(
      await pass(userId, D0, [meeting("m1", "2026-10-15T09:00:00Z", "pat@x.example")]),
    ).toMatchObject({ meetings: 1 });

    expect(await read(userId, D0)).toMatchObject({
      meetingCount: 1,
      smallMeetingCount: 1,
      lastMetAt: day("2026-10-15"),
      coAttendanceObservedSince: day("2026-09-20"),
      coAttendanceCountedThrough: day("2026-10-19"),
    });
    expect(await read(userId, D0, "lee@x.example")).toMatchObject({
      meetingCount: 0,
      smallMeetingCount: 0,
      lastMetAt: null,
    });
  });

  it("a watermark at today − 2 still reads 0; a day later it is null", async () => {
    const userId = await newUser();
    await pass(userId, D0);
    expect(await watermarkOf(userId)).toEqual(new Date(day("2026-10-19")));

    expect(await read(userId, later(1))).toMatchObject({ meetingCount: 0 });
    expect(await read(userId, later(2))).toMatchObject({
      meetingCount: null,
      coAttendanceCountedThrough: null,
    });
  });

  it("probe A: a Google calendar linked later reads null, though the primary is covered", async () => {
    const userId = await newUser();
    await pass(userId, D0);
    expect(await read(userId, D0)).toMatchObject({ meetingCount: 0 });

    const cal = await linkCalendar(userId);
    await pass(userId, later(1), [], [{ id: cal.id, email: cal.email, session: listing([]) }]);
    expect(await watermarkOf(userId)).toEqual(new Date(day("2026-10-20")));
    const linked = await prisma.linkedCalendarAccount.findUnique({ where: { id: cal.id } });
    expect(linked?.coAttendanceObservedSince).toEqual(new Date(day("2026-10-20")));

    expect(await read(userId, later(1))).toMatchObject({
      meetingCount: null,
      coAttendanceObservedSince: null,
    });
  });

  it("probe C: a failing linked calendar freezes the watermark: null, though the primary's pass is fresh", async () => {
    const userId = await newUser();
    const cal = await linkCalendar(userId);
    const ok = [{ id: cal.id, email: cal.email, session: listing([]) }];
    const down = [{ id: cal.id, email: cal.email, session: failing }];
    await pass(userId, D0, [], ok);
    expect(await read(userId, D0)).toMatchObject({ meetingCount: 0 });

    expect(await pass(userId, later(1), [], down)).toBeNull();
    expect(await pass(userId, later(2), [], down)).toBeNull();
    expect(await watermarkOf(userId)).toEqual(new Date(day("2026-10-19")));
    const token = await prisma.userToken.findFirst({ where: { userId, provider: "google" } });
    expect(token?.coAttendanceLastPassAt).toEqual(later(2));

    expect(await read(userId, later(2))).toMatchObject({ meetingCount: null });
  });
});
