/**
 * Where the meeting-starting-soon push opens (background.ts). The push used to
 * carry the https join link as its `url`; the service worker opens app paths
 * only (an invite's link is anyone's to write), so the tap fell back to /chat.
 * The push now opens the event's own page, which shows the join link, and the
 * calendar when the event has no synced row. The bell row keeps the join link:
 * the web bell validates it and opens it outside the app.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-11-07T09:00:00Z");

const mocks = vi.hoisted(() => ({
  sendPushNotification: vi.fn(async () => ({ status: "sent" })),
  notificationCreate: vi.fn(async () => ({ id: "notif-m1", createdAt: new Date() })),
  calendarFindUnique: vi.fn(),
  getUpcomingMeetings: vi.fn(),
}));

vi.mock("../db.js", () => ({
  prisma: {
    userToken: { findMany: vi.fn(async () => [{ userId: "u1" }]) },
    automationConfig: { findUnique: vi.fn(async () => null) },
    notification: { findFirst: vi.fn(async () => null), create: mocks.notificationCreate },
    calendarEvent: { findUnique: mocks.calendarFindUnique },
  },
}));
vi.mock("../pim/meeting.js", () => ({ getUpcomingMeetings: mocks.getUpcomingMeetings }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
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

const JOIN = "https://meet.google.com/abc-defg-hij";

/** The user's primary-calendar row: what getUpcomingMeetings lists. */
function primaryRow(id: string) {
  return { id, sourceAccountId: null, provider: "GOOGLE" };
}

function meetingSoon(id: string) {
  mocks.getUpcomingMeetings.mockResolvedValue([
    {
      id,
      summary: "Standup",
      start: new Date(NOW.getTime() + 3 * 60_000).toISOString(),
      meetingLink: JOIN,
    },
  ]);
}

async function pushedUrl(): Promise<string> {
  startBackgroundAgent();
  await vi.waitFor(() => expect(mocks.sendPushNotification).toHaveBeenCalledTimes(1));
  const payload = (
    mocks.sendPushNotification.mock.calls[0] as unknown as [string, { url: string }]
  )[1];
  return payload.url;
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW.getTime());
  vi.spyOn(console, "log").mockImplementation(() => {});
  mocks.sendPushNotification.mockClear();
  mocks.notificationCreate.mockClear();
  mocks.calendarFindUnique.mockReset();
});

afterEach(() => {
  stopBackgroundAgent();
  vi.restoreAllMocks();
});

describe("meeting-starting-soon push target", () => {
  it("opens the event's page, looked up by the user's own Google event id", async () => {
    meetingSoon("gcal-evt-1");
    mocks.calendarFindUnique.mockResolvedValue(primaryRow("cal-row-1"));

    expect(await pushedUrl()).toBe("/calendar/cal-row-1");
    expect(mocks.calendarFindUnique).toHaveBeenCalledWith({
      where: { userId_googleId: { userId: "u1", googleId: "gcal-evt-1" } },
      select: { id: true, sourceAccountId: true, provider: true },
    });
  });

  it("opens the calendar for a row the event page would refuse to show", async () => {
    meetingSoon("gcal-evt-6");
    // A linked calendar's row while linked-calendar sync is off (the default).
    mocks.calendarFindUnique.mockResolvedValue({
      id: "cal-row-6",
      sourceAccountId: "linked-1",
      provider: "GOOGLE",
    });
    expect(await pushedUrl()).toBe("/calendar");
  });

  it("never hands the push the off-app join link", async () => {
    meetingSoon("gcal-evt-2");
    mocks.calendarFindUnique.mockResolvedValue(primaryRow("cal-row-2"));
    expect(await pushedUrl()).not.toContain("meet.google.com");
  });

  it("opens the calendar when the event has no synced row yet", async () => {
    meetingSoon("gcal-evt-3");
    mocks.calendarFindUnique.mockResolvedValue(null);
    expect(await pushedUrl()).toBe("/calendar");
  });

  it("still rings, to the calendar, when the lookup fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    meetingSoon("gcal-evt-4");
    mocks.calendarFindUnique.mockRejectedValue(new Error("db blip"));
    expect(await pushedUrl()).toBe("/calendar");
  });

  it("the bell row keeps the join link (the web bell opens it outside the app)", async () => {
    meetingSoon("gcal-evt-5");
    mocks.calendarFindUnique.mockResolvedValue(primaryRow("cal-row-5"));
    await pushedUrl();
    const data = (
      mocks.notificationCreate.mock.calls[0] as unknown as [{ data: { link: string } }]
    )[0].data;
    expect(data.link).toBe(JOIN);
  });
});
