/**
 * Meeting-starting-soon interrupt (background.ts): the device push names the
 * bell row it rings for, so an open browser tab and the service worker give
 * the same meeting one OS tag instead of showing it twice.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-11-07T09:00:00Z");

const mocks = vi.hoisted(() => ({
  pushNotification: vi.fn(),
  sendPushNotification: vi.fn(async () => ({ status: "sent" })),
  notificationCreate: vi.fn(async () => ({ id: "notif-m1", createdAt: new Date() })),
  getUpcomingMeetings: vi.fn(),
}));

vi.mock("../db.js", () => ({
  prisma: {
    userToken: { findMany: vi.fn(async () => [{ userId: "u1" }]) },
    automationConfig: { findUnique: vi.fn(async () => null) },
    notification: { findFirst: vi.fn(async () => null), create: mocks.notificationCreate },
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

afterEach(() => {
  stopBackgroundAgent();
});

describe("meeting-starting-soon push", () => {
  it("carries the bell notification id of the tagged frame it mirrors", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW.getTime());
    vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.getUpcomingMeetings.mockResolvedValue([
      {
        id: "evt-1",
        summary: "Standup",
        start: new Date(NOW.getTime() + 3 * 60_000).toISOString(),
        meetingLink: null,
      },
    ]);

    startBackgroundAgent();
    await vi.waitFor(() => expect(mocks.sendPushNotification).toHaveBeenCalledTimes(1));

    const frame = mocks.pushNotification.mock.calls[0][1] as { id: string; alert?: string };
    expect(frame).toMatchObject({ id: "notif-m1", alert: "meeting" });
    const [, payload, category] = mocks.sendPushNotification.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      string,
    ];
    expect(category).toBe("meeting");
    expect(payload).toEqual({
      title: "Meeting in 3 min",
      body: "Standup",
      // No synced row for the event yet: the calendar, never an off-app link.
      url: "/calendar",
      bellNotificationId: frame.id,
    });
  });
});
