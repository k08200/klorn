/**
 * Meeting-starting-soon interrupt (background.ts): the device push names the
 * bell row it rings for, so an open browser tab and the service worker give
 * the same meeting one OS tag instead of showing it twice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callText } from "./helpers/canary.js";
import { DB_CANARY } from "./helpers/prisma-canary.js";

const NOW = new Date("2026-11-07T09:00:00Z");

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  pushNotification: vi.fn(),
  sendPushNotification: vi.fn(async () => ({ status: "sent" })),
  notificationCreate: vi.fn(async () => ({ id: "notif-m1", createdAt: new Date() })),
  getUpcomingMeetings: vi.fn(),
  captureError: vi.fn(),
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
vi.mock("../sentry.js", () => ({ captureError: mocks.captureError }));

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
      presentation: { kind: "meet" },
    });
  });

  it("carries the NT0 meet fields: the join link and how many are invited, never who", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW.getTime());
    vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.getUpcomingMeetings.mockResolvedValue([
      {
        id: "evt-2",
        summary: "Design review",
        start: new Date(NOW.getTime() + 3 * 60_000).toISOString(),
        meetingLink: "https://meet.google.com/abc-defg-hij",
        attendees: ["a@x.com", "b@x.com", "c@x.com"],
        attendeeCount: 3,
      },
    ]);

    startBackgroundAgent();
    await vi.waitFor(() =>
      expect(
        (
          mocks.sendPushNotification.mock.calls as unknown as Array<[string, { body?: string }]>
        ).some(([, p]) => p.body === "Design review"),
      ).toBe(true),
    );

    const fields = {
      kind: "meet",
      joinUrl: "https://meet.google.com/abc-defg-hij",
      attendeeCount: 3,
    };
    const calls = mocks.sendPushNotification.mock.calls as unknown as Array<
      [string, { body?: string; presentation?: unknown }]
    >;
    const payload = calls.find(([, p]) => p.body === "Design review")?.[1];
    expect(payload?.presentation).toEqual(fields);
    const frames = mocks.pushNotification.mock.calls as unknown as Array<[string, Row]>;
    expect(frames.find(([, f]) => f.kind === "meet" && "joinUrl" in f)?.[1]).toMatchObject(fields);
    expect(JSON.stringify(mocks.sendPushNotification.mock.calls)).not.toContain("a@x.com");
  });
});

describe("a failed meeting push", () => {
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    consoleSpies = (["log", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
  });

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore();
  });

  const sinkText = () =>
    `${consoleSpies.map((spy) => callText(spy)).join("\n")}\n${callText(mocks.captureError)}`;

  it("is logged as facts: the web-push error quotes the payload (the meeting title), the report never does", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW.getTime());
    mocks.getUpcomingMeetings.mockResolvedValue([
      {
        id: "evt-push-fails",
        summary: `${DB_CANARY} board review`,
        start: new Date(NOW.getTime() + 3 * 60_000).toISOString(),
        meetingLink: null,
      },
    ]);
    // web-push raises WebPushError with the endpoint's reply and the payload it sent.
    mocks.sendPushNotification.mockRejectedValueOnce(
      Object.assign(
        new Error(
          `Received unexpected response code: payload {"title":"Meeting in 3 min","body":"${DB_CANARY} board review"}`,
        ),
        { name: "WebPushError", statusCode: 400 },
      ),
    );

    startBackgroundAgent();
    await vi.waitFor(() => expect(sinkText()).toContain("[BACKGROUND] meeting push failed"));

    expect(sinkText()).not.toContain(DB_CANARY);
    expect(sinkText()).toContain("userId=u1");
    expect(sinkText()).toContain("WebPushError");
  });
});
