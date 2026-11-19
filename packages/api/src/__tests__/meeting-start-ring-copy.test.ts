/**
 * The meeting start ring (background.ts, T-5):
 *   - NT0 meet copy while NOTIFY_PUSH_PRESENTATION is open to the user: title =
 *     the event, body = "10분 후 · Google Meet · 3명". Off, the push is exactly
 *     what it was ("Meeting in 3 min" / the event title). The bell row and the
 *     live frame keep their text either way (the row carries the dedupe marker).
 *   - The ring asks the calendar read to fall back to the stored rows when the
 *     live Google listing fails (pim/meeting.ts), and a tick that read nothing
 *     is retried by the next one inside the 5-minute window.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-11-07T09:00:00Z");

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  pushNotification: vi.fn(),
  sendPushNotification: vi.fn(async () => ({ status: "sent" })),
  notificationCreate: vi.fn(async () => ({ id: "notif-m1", createdAt: new Date() })),
  getUpcomingMeetings: vi.fn(),
  config: null as Row | null,
  priorRing: null as Row | null,
}));

vi.mock("../db.js", () => ({
  prisma: {
    userToken: { findMany: vi.fn(async () => [{ userId: "u1" }]) },
    automationConfig: { findUnique: vi.fn(async () => mocks.config) },
    notification: {
      findFirst: vi.fn(async () => mocks.priorRing),
      create: mocks.notificationCreate,
    },
    calendarEvent: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("../pim/meeting.js", () => ({ getUpcomingMeetings: mocks.getUpcomingMeetings }));
vi.mock("../websocket.js", () => ({ pushNotification: mocks.pushNotification }));
vi.mock("../notify/push.js", () => ({ sendPushNotification: mocks.sendPushNotification }));
vi.mock("../notify/desktop-alert.js", () => ({
  desktopAlertTag: vi.fn(async () => ({ alert: "meeting" })),
}));
vi.mock("../scheduler-heartbeat.js", () => ({
  recordSchedulerTick: vi.fn(),
  registerScheduler: vi.fn(),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { startBackgroundAgent, stopBackgroundAgent } from "../background.js";

// background.ts remembers rung ids for the process: every test rings its own event.
const meetingWith = (id: string) => ({
  id,
  summary: "디자인 리뷰",
  start: new Date(NOW.getTime() + 3 * 60_000).toISOString(),
  meetingLink: "https://meet.google.com/abc-defg-hij",
  attendees: [],
  attendeeCount: 3,
});

type PushCall = [string, { title: string; body: string; presentation?: Row }, string];
const pushes = () => mocks.sendPushNotification.mock.calls as unknown as PushCall[];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config = null;
  mocks.priorRing = null;
  vi.spyOn(console, "log").mockImplementation(() => {});
  delete process.env.NOTIFY_PUSH_PRESENTATION;
});

afterEach(() => {
  stopBackgroundAgent();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.NOTIFY_PUSH_PRESENTATION;
});

describe("meeting start ring — NT0 meet copy", () => {
  it("flag on: title = the event, body = relative start · provider · how many, in the user's language", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW.getTime());
    process.env.NOTIFY_PUSH_PRESENTATION = "on";
    mocks.config = { notificationLanguage: "ko", meetingAutoJoin: true };
    mocks.getUpcomingMeetings.mockResolvedValue([meetingWith("evt-on")]);

    startBackgroundAgent();
    await vi.waitFor(() => expect(pushes()).toHaveLength(1));

    const [, payload, category] = pushes()[0];
    expect(category).toBe("meeting");
    expect(payload.title).toBe("디자인 리뷰");
    expect(payload.body).toBe("3분 후 · Google Meet · 3명");
    expect(payload.presentation).toEqual({
      kind: "meet",
      joinUrl: "https://meet.google.com/abc-defg-hij",
      attendeeCount: 3,
    });
    // The bell row keeps its text and its [event id] dedupe marker.
    const row = (mocks.notificationCreate.mock.calls[0] as unknown as [{ data: Row }])[0].data;
    expect(row.title).toBe("Meeting in 3 min: 디자인 리뷰");
    expect(String(row.message)).toContain("[evt-on]");
  });

  it("flag off: the push is exactly what it was", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW.getTime());
    mocks.config = { notificationLanguage: "ko", meetingAutoJoin: true };
    mocks.getUpcomingMeetings.mockResolvedValue([meetingWith("evt-off")]);

    startBackgroundAgent();
    await vi.waitFor(() => expect(pushes()).toHaveLength(1));

    expect(pushes()[0][1]).toEqual({
      title: "Meeting in 3 min",
      body: "디자인 리뷰",
      url: "/calendar",
      bellNotificationId: "notif-m1",
      presentation: {
        kind: "meet",
        joinUrl: "https://meet.google.com/abc-defg-hij",
        attendeeCount: 3,
      },
    });
  });
});

describe("meeting start ring — a failed live read", () => {
  it("asks the calendar read to fall back to the stored rows", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW.getTime());
    mocks.getUpcomingMeetings.mockResolvedValue([]);

    startBackgroundAgent();
    await vi.waitFor(() => expect(mocks.getUpcomingMeetings).toHaveBeenCalled());

    expect(mocks.getUpcomingMeetings).toHaveBeenCalledWith("u1", { storedOnFailure: true });
  });

  it("a tick that read nothing is retried by the next tick inside the window, and rings once", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let clock = NOW.getTime();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    mocks.getUpcomingMeetings
      .mockResolvedValueOnce([])
      .mockResolvedValue([meetingWith("evt-retry")]);

    startBackgroundAgent();
    await vi.waitFor(() => expect(mocks.getUpcomingMeetings).toHaveBeenCalledTimes(1));
    expect(pushes()).toHaveLength(0);

    clock += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(pushes()).toHaveLength(1));

    clock += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(mocks.getUpcomingMeetings).toHaveBeenCalledTimes(3));
    expect(pushes()).toHaveLength(1);
  });

  it("a meeting already rung under its event id (by a stored-row ring, say) does not ring again", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW.getTime());
    // The bell row the earlier ring wrote: its message carries the [event id] marker.
    mocks.priorRing = {
      id: "notif-old",
      message: "Join link: https://meet.google.com/x [evt-again]",
    };
    mocks.getUpcomingMeetings.mockResolvedValue([meetingWith("evt-again")]);

    startBackgroundAgent();
    await vi.waitFor(() => expect(mocks.getUpcomingMeetings).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(pushes()).toHaveLength(0);
    const { prisma } = await import("../db.js");
    expect(vi.mocked(prisma.notification.findFirst).mock.calls[0][0]).toMatchObject({
      where: { userId: "u1", type: "meeting", message: { contains: "evt-again" } },
    });
  });
});
