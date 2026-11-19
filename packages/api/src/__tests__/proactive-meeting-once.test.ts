import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * NT0 item 11 — one meeting, one notification. Two paths announced the same
 * meeting: background.ts rings a primary-calendar meeting with a video link at
 * T-5 (interrupt, join link), and the proactive heads-up rang it again at
 * T-60 (agentcore/proactive-actions.ts checkUpcomingMeetings). The heads-up now
 * leaves such a meeting to the start ring, counts an invite present in the
 * primary and a linked calendar once, and dedupes by a bell-row key (event row
 * + start) instead of a 20-character title prefix.
 */

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  events: [] as Row[],
  token: { accessToken: "enc-a", refreshToken: "enc-r", expiresAt: null } as Row | null,
  config: { timezone: "Asia/Seoul", meetingAutoJoin: true } as Row | null,
  created: [] as Row[],
  attempted: [] as Row[],
  createFails: null as Error | null,
}));

vi.mock("../db.js", () => {
  const empty = async () => [];
  const prisma = {
    automationConfig: { findUnique: vi.fn(async () => db.config) },
    userToken: { findFirst: vi.fn(async () => db.token) },
    calendarEvent: { findMany: vi.fn(async () => db.events) },
    emailMessage: { findMany: vi.fn(empty), count: vi.fn(async () => 0) },
    notification: {
      // The old title-prefix dedupe, emulated: a row whose title contains the given text.
      findFirst: vi.fn(async ({ where }: { where: { title?: { contains?: string } } }) => {
        const part = where.title?.contains;
        return part ? (db.created.find((n) => String(n.title).includes(part)) ?? null) : null;
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        db.attempted.push(data);
        if (db.createFails) throw db.createFails;
        db.created.push(data);
        return { id: `n${db.created.length}`, createdAt: new Date(), ...data };
      }),
    },
    contact: { findFirst: vi.fn(async () => null) },
    attentionItem: { findMany: vi.fn(empty) },
    task: { findMany: vi.fn(empty), count: vi.fn(async () => 0) },
  };
  return { prisma };
});
vi.mock("../notify/push.js", () => ({ sendPushNotification: vi.fn(async () => undefined) }));
vi.mock("../notify/sms.js", () => ({ sendSms: vi.fn(async () => undefined) }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../pim/calendar-read.js", () => ({ countCalendarRows: vi.fn(async () => 0) }));
vi.mock("../report-db-failure.js", () => ({ logDbFailure: vi.fn(), captureDbFailure: vi.fn() }));
vi.mock("../agentcore/evening-review.js", () => ({
  gatherEveningReviewInput: vi.fn(async () => ({})),
  eveningReviewHasContent: vi.fn(() => false),
  composeEveningReview: vi.fn(() => null),
}));

import { runProactiveActions } from "../agentcore/proactive-actions.js";
import { sendPushNotification } from "../notify/push.js";
import { sendSms } from "../notify/sms.js";
import { logDbFailure } from "../report-db-failure.js";

const NOW = new Date("2026-11-18T05:00:00.000Z");
const START = new Date(NOW.getTime() + 62 * 60 * 1000);

function event(id: string, extra: Row = {}): Row {
  return {
    id,
    title: `Design review ${id}`,
    startTime: START,
    location: null,
    meetingLink: null,
    description: null,
    provider: "GOOGLE",
    externalId: `ext-${id}`,
    sourceAccountId: null,
    attendeeCount: null,
    ...extra,
  };
}

const meetingRows = () => db.created.filter((n) => n.type === "calendar");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db.events = [];
  db.token = { accessToken: "enc-a", refreshToken: "enc-r", expiresAt: null };
  db.config = { timezone: "Asia/Seoul", meetingAutoJoin: true };
  db.created = [];
  db.attempted = [];
  db.createFails = null;
  delete process.env.BACKGROUND_AGENTS_DISABLED;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.BACKGROUND_AGENTS_DISABLED;
});

describe("proactive meeting heads-up — one meeting, one notification", () => {
  it("leaves a primary Google meeting with a video link to the start ring", async () => {
    db.events = [
      event("linked-call", { meetingLink: "https://meet.google.com/abc-defg-hij" }),
      event("zoom-in-text", { description: "Join https://acme.zoom.us/j/123 now" }),
      event("no-link"),
    ];
    await runProactiveActions("u1");
    expect(meetingRows().map((n) => n.title)).toEqual(["Meeting in 1 hour: Design review no-link"]);
  });

  it("still announces a linked calendar's video meeting (the start ring reads the primary only)", async () => {
    db.events = [
      event("other-cal", {
        meetingLink: "https://meet.google.com/abc-defg-hij",
        sourceAccountId: "lca-1",
        externalId: "ext-other",
      }),
    ];
    await runProactiveActions("u1");
    expect(meetingRows()).toHaveLength(1);
  });

  it("announces it when the start ring does not run for the user", async () => {
    const linked = [event("call", { meetingLink: "https://meet.google.com/abc-defg-hij" })];
    db.events = linked;
    db.config = { timezone: "Asia/Seoul", meetingAutoJoin: false };
    await runProactiveActions("u1");
    expect(meetingRows()).toHaveLength(1);

    db.created = [];
    db.config = { timezone: "Asia/Seoul", meetingAutoJoin: true };
    db.token = null;
    await runProactiveActions("u1");
    expect(meetingRows()).toHaveLength(1);

    db.created = [];
    db.token = { accessToken: "enc-a", refreshToken: "enc-r", expiresAt: null };
    process.env.BACKGROUND_AGENTS_DISABLED = "true";
    await runProactiveActions("u1");
    expect(meetingRows()).toHaveLength(1);
  });

  it("keeps the heads-up when the Google token cannot reach Google (the start ring would ring nothing)", async () => {
    db.events = [event("call", { meetingLink: "https://meet.google.com/abc-defg-hij" })];
    // Invalidated: mail/gmail.ts blanks both tokens.
    db.token = { accessToken: "", refreshToken: null, expiresAt: null };
    await runProactiveActions("u1");
    expect(meetingRows()).toHaveLength(1);

    db.created = [];
    // No refresh token, and the access token lapses before the meeting starts.
    db.token = {
      accessToken: "enc-a",
      refreshToken: null,
      expiresAt: new Date(NOW.getTime() + 60_000),
    };
    await runProactiveActions("u1");
    expect(meetingRows()).toHaveLength(1);
  });

  it("leaves a linked-calendar copy of a start-ring meeting to the start ring too", async () => {
    db.events = [
      event("g", {
        title: "Design review",
        meetingLink: "https://meet.google.com/abc-defg-hij",
        externalId: "google-id",
      }),
      event("o", {
        title: "Design Review ",
        provider: "OUTLOOK",
        externalId: "outlook-id",
        sourceAccountId: "lca-outlook",
      }),
    ];
    await runProactiveActions("u1");
    expect(meetingRows()).toEqual([]);
  });

  it("keeps the join link out of the device push body unless NOTIFY_PUSH_QUOTE is open", async () => {
    db.events = [
      event("other-cal", {
        meetingLink: "https://meet.google.com/abc-defg-hij",
        sourceAccountId: "lca-1",
      }),
    ];
    await runProactiveActions("u1");
    const body = vi.mocked(sendPushNotification).mock.calls[0][1].body;
    expect(body).not.toContain("meet.google.com");
    // The bell row (first-party) keeps it.
    expect(String(meetingRows()[0].message)).toContain("https://meet.google.com/abc-defg-hij");

    vi.mocked(sendPushNotification).mockClear();
    db.created = [];
    process.env.NOTIFY_PUSH_QUOTE = "on";
    db.events = [
      event("other-cal-2", {
        meetingLink: "https://meet.google.com/xyz",
        sourceAccountId: "lca-1",
      }),
    ];
    await runProactiveActions("u1");
    expect(vi.mocked(sendPushNotification).mock.calls[0][1].body).toContain(
      "https://meet.google.com/xyz",
    );
    delete process.env.NOTIFY_PUSH_QUOTE;
  });

  it("counts an invite in the primary and a linked calendar once", async () => {
    db.events = [
      event("p", { externalId: "same-invite" }),
      event("l", { externalId: "same-invite", sourceAccountId: "lca-1" }),
    ];
    await runProactiveActions("u1");
    expect(meetingRows()).toHaveLength(1);
    expect(meetingRows()[0].dedupeKey).toBe(`meeting-prep:p:${START.getTime()}`);
  });

  it("two meetings sharing a title prefix are both announced", async () => {
    db.events = [
      event("a", { title: "Weekly sync with the design team" }),
      event("b", { title: "Weekly sync with the design team — EU" }),
    ];
    await runProactiveActions("u1");
    expect(meetingRows()).toHaveLength(2);
  });

  it("a taken dedupe key (an overlapping tick already rang) sends no push and no SMS", async () => {
    db.events = [event("no-link")];
    db.createFails = Object.assign(new Error("dup"), { code: "P2002" });
    await runProactiveActions("u1");
    expect(db.attempted[0]?.dedupeKey).toBe(`meeting-prep:no-link:${START.getTime()}`);
    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
    // A taken key is the dedupe working, not a failed check.
    expect(vi.mocked(logDbFailure).mock.calls.map((c) => c[0])).not.toContain(
      "[PROACTIVE] check failed",
    );
  });

  it("carries the meet kind, the join link and the attendee count", async () => {
    db.events = [
      event("other-cal", {
        meetingLink: "https://meet.google.com/abc-defg-hij",
        sourceAccountId: "lca-1",
        attendeeCount: 3,
      }),
    ];
    await runProactiveActions("u1");
    const call = vi.mocked(sendPushNotification).mock.calls[0];
    expect(call[1].presentation).toEqual({
      kind: "meet",
      joinUrl: "https://meet.google.com/abc-defg-hij",
      attendeeCount: 3,
    });
  });
});

describe("proactive meeting heads-up — NT0 meet copy (NOTIFY_PUSH_PRESENTATION)", () => {
  afterEach(() => {
    delete process.env.NOTIFY_PUSH_PRESENTATION;
    delete process.env.NOTIFY_PUSH_QUOTE;
  });

  const linkedMeeting = () =>
    event("other-cal", {
      title: "디자인 리뷰",
      meetingLink: "https://meet.google.com/abc-defg-hij",
      sourceAccountId: "lca-1",
      location: "Room 4",
      attendeeCount: 3,
    });

  it("flag on: the push reads title = the event, body = relative start · provider · how many", async () => {
    process.env.NOTIFY_PUSH_PRESENTATION = "on";
    process.env.NOTIFY_PUSH_QUOTE = "on";
    db.config = { timezone: "Asia/Seoul", meetingAutoJoin: true, notificationLanguage: "ko" };
    db.events = [linkedMeeting()];
    await runProactiveActions("u1");

    const payload = vi.mocked(sendPushNotification).mock.calls[0][1];
    expect(payload.title).toBe("디자인 리뷰");
    // 62 minutes out, floored to the 5-minute step: no tick-timing jitter.
    expect(payload.body).toBe("1시간 후 · Google Meet · 3명");
    // The bell row keeps its own text.
    expect(meetingRows()[0].title).toBe("Meeting in 1 hour: 디자인 리뷰");
  });

  it("flag off: the push is exactly what it was", async () => {
    db.config = { timezone: "Asia/Seoul", meetingAutoJoin: true, notificationLanguage: "ko" };
    db.events = [linkedMeeting()];
    await runProactiveActions("u1");

    const payload = vi.mocked(sendPushNotification).mock.calls[0][1];
    expect(payload.title).toBe("Meeting in 1 hour: 디자인 리뷰");
    expect(payload.body).toBe("디자인 리뷰 starts at 03:02 PM @ Room 4");
  });
});
