/**
 * The meeting start ring (background.ts, T-5) reads the primary Google
 * calendar live. When that listing failed, getUpcomingMeetings returned [] and
 * the ring announced nothing; the T-60 heads-up had already left the meeting
 * to it (meeting-start-ring.ts), so a Google outage spanning the 5-minute
 * window cost the meeting its only alert.
 *
 * With `storedOnFailure` (the start ring only) a failed listing falls back to
 * the user's stored primary-calendar rows starting inside the window, with a
 * join link, minus any meeting whose heads-up already rang (its bell key
 * `meeting-prep:<rowId>:<startMs>`), so one meeting still gets one alert. A
 * missing grant (no client) is not a failure: the heads-up covers that case.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  rung: [] as string[],
  calendarFindMany: vi.fn(),
  notificationFindMany: vi.fn(),
}));

vi.mock("../mail/gmail.js", () => ({ getAuthedClient: vi.fn() }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../llm/openai.js", () => ({ createCompletion: vi.fn(), MODEL: {} }));
vi.mock("../db.js", () => ({
  prisma: {
    calendarEvent: { findMany: db.calendarFindMany },
    notification: { findMany: db.notificationFindMany },
  },
}));

const eventsList = vi.fn();
vi.mock("googleapis", () => ({
  google: { calendar: vi.fn(() => ({ events: { list: eventsList } })) },
}));

import { getAuthedClient } from "../mail/gmail.js";
import { getUpcomingMeetings } from "../pim/meeting.js";

const NOW = new Date("2026-11-18T05:00:00.000Z");
const fakeAuth = {} as Awaited<ReturnType<typeof getAuthedClient>>;

function row(id: string, minutes: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    googleId: `g-${id}`,
    externalId: `g-${id}`,
    sourceAccountId: null,
    title: `Review ${id}`,
    startTime: new Date(NOW.getTime() + minutes * 60_000),
    endTime: new Date(NOW.getTime() + (minutes + 30) * 60_000),
    meetingLink: "https://meet.google.com/abc-defg-hij",
    description: null,
    location: null,
    attendeeCount: 4,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  db.rows = [];
  db.rung = [];
  db.calendarFindMany.mockImplementation(async () => db.rows);
  db.notificationFindMany.mockImplementation(
    async ({ where }: { where: { dedupeKey: { in: string[] } } }) =>
      db.rung.filter((key) => where.dedupeKey.in.includes(key)).map((dedupeKey) => ({ dedupeKey })),
  );
  vi.mocked(getAuthedClient).mockResolvedValue(fakeAuth);
});

describe("getUpcomingMeetings — the start ring's stored fallback", () => {
  it("a failed listing reads the stored rows that start inside the window", async () => {
    eventsList.mockRejectedValue(new Error("socket hang up"));
    db.rows = [row("a", 3)];

    const meetings = await getUpcomingMeetings("u1", { storedOnFailure: true });

    expect(meetings).toEqual([
      {
        id: "g-a",
        summary: "Review a",
        start: row("a", 3).startTime.toISOString(),
        end: row("a", 3).endTime.toISOString(),
        meetingLink: "https://meet.google.com/abc-defg-hij",
        attendees: [],
        attendeeCount: 4,
      },
    ]);
    const [{ where }] = db.calendarFindMany.mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(where).toMatchObject({
      userId: "u1",
      provider: "GOOGLE",
      sourceAccountId: null,
      allDay: false,
      externalId: { not: null },
      startTime: { gt: NOW, lte: new Date(NOW.getTime() + 5 * 60_000) },
    });
  });

  it("leaves out a meeting whose heads-up already rang, and a row with no join link", async () => {
    eventsList.mockRejectedValue(new Error("503"));
    db.rows = [
      row("rang", 3),
      row("fresh", 4),
      row("no-link", 2, { meetingLink: null }),
      row("link-in-text", 2, { meetingLink: null, description: "Join https://acme.zoom.us/j/1" }),
    ];
    db.rung = [`meeting-prep:rang:${row("rang", 3).startTime.getTime()}`];

    const meetings = await getUpcomingMeetings("u1", { storedOnFailure: true });

    expect(meetings.map((m) => m.id)).toEqual(["g-fresh", "g-link-in-text"]);
    expect(meetings[1].meetingLink).toBe("https://acme.zoom.us/j/1");
  });

  it("a successful listing never reads the stored rows", async () => {
    eventsList.mockResolvedValue({ data: { items: [] } });

    expect(await getUpcomingMeetings("u1", { storedOnFailure: true })).toEqual([]);
    expect(db.calendarFindMany).not.toHaveBeenCalled();
  });

  it("no Google client (no or dead grant) is not a failure: nothing stored is read", async () => {
    vi.mocked(getAuthedClient).mockResolvedValue(null);

    expect(await getUpcomingMeetings("u1", { storedOnFailure: true })).toEqual([]);
    expect(db.calendarFindMany).not.toHaveBeenCalled();
  });

  it("without the option (the agent's tool) a failed listing still returns []", async () => {
    eventsList.mockRejectedValue(new Error("socket hang up"));
    db.rows = [row("a", 3)];

    expect(await getUpcomingMeetings("u1")).toEqual([]);
    expect(db.calendarFindMany).not.toHaveBeenCalled();
  });

  it("a failing stored read returns [] and is reported as facts", async () => {
    eventsList.mockRejectedValue(new Error("socket hang up"));
    db.calendarFindMany.mockRejectedValue(new Error("db down"));

    expect(await getUpcomingMeetings("u1", { storedOnFailure: true })).toEqual([]);
  });
});
