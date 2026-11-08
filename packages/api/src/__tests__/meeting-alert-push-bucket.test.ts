/**
 * Meeting-starting-soon alert (background.ts): one of the four callers allowed
 * to ask for the interrupt rate bucket (push-bucket.ts,
 * push-interrupt-callers-guard.test.ts). The category stays "meeting", which
 * still drives the notifyMeeting preference, quiet hours and the label.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-11-08T09:00:00Z");

const mocks = vi.hoisted(() => ({
  sendPushNotification: vi.fn(async () => ({ status: "sent" })),
  getUpcomingMeetings: vi.fn(),
}));

vi.mock("../db.js", () => ({
  prisma: {
    userToken: { findMany: vi.fn(async () => [{ userId: "u1" }]) },
    automationConfig: { findUnique: vi.fn(async () => null) },
    notification: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "notif-m1", createdAt: new Date() })),
    },
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

afterEach(() => {
  stopBackgroundAgent();
  vi.restoreAllMocks();
});

describe("meeting-starting-soon push", () => {
  it("rings against the interrupt bucket, still under the meeting category", async () => {
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

    const [userId, , category, options] = mocks.sendPushNotification.mock.calls[0] as unknown as [
      string,
      unknown,
      string,
      unknown,
    ];
    expect(userId).toBe("u1");
    expect(category).toBe("meeting");
    expect(options).toEqual({ bucket: "interrupt" });
  });
});
