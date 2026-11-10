import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

// GET /api/notifications/alert-state — the server's own answer to "may Klorn
// raise a desktop banner right now?" for the native Mac app, which learns about
// PUSH / MEETING mail and upcoming meetings by polling and so never sees the
// `alert` tag the Windows shell reads off real-time frames. It must be the SAME
// gate (notify/desktop-alert.ts → notify/notification-prefs.ts): category
// opt-outs, quiet hours in the user's time zone, and the focus-window rule.
// The gate modules run for real here; only the DB is mocked.

process.env.PUSH_ALLOWED_ORIGINS = "https://app.klorn.ai";

const db = vi.hoisted(() => ({
  automationConfigFindUnique: vi.fn(),
  calendarEventFindFirst: vi.fn(),
}));

vi.mock("../mail/email.js", () => ({
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));
vi.mock("../mail/gmail.js", () => ({
  getAuthUrl: vi.fn(),
  getLoginAuthUrl: vi.fn(),
  getAuthedClient: vi.fn(),
  getGoogleUserInfo: vi.fn(),
  getOAuth2Client: vi.fn(),
}));
vi.mock("../background.js", () => ({
  getNotifications: vi.fn(async () => []),
  markNotificationRead: vi.fn(async () => {}),
  markAllNotificationsRead: vi.fn(async () => {}),
  clearNotifications: vi.fn(async () => {}),
}));
vi.mock("../notify/push.js", () => ({
  getVapidPublicKey: vi.fn(() => "test-vapid-key"),
  sendPushNotification: vi.fn(),
}));
vi.mock("../notify/push-device.js", () => ({ sendDevicePush: vi.fn() }));
vi.mock("../notify/push-delivery.js", () => ({
  recordPushReceipt: vi.fn(),
  getPushDeliveryStats: vi.fn(),
}));
vi.mock("../db.js", () => {
  const prisma = {
    automationConfig: { findUnique: db.automationConfigFindUnique },
    calendarEvent: { findFirst: db.calendarEventFindFirst },
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })) },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const auth = { authorization: `Bearer ${TOKEN}` };
const URL = "/api/notifications/alert-state";

async function buildApp() {
  const { notificationRoutes } = await import("../routes/notifications.js");
  const app = Fastify();
  await app.register(notificationRoutes, { prefix: "/api/notifications" });
  return app;
}

async function alertState(url = URL) {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url, headers: auth });
  await app.close();
  return res;
}

const ALLOWED = { allowed: true };

describe("GET /api/notifications/alert-state", () => {
  beforeEach(() => {
    db.automationConfigFindUnique.mockReset();
    db.calendarEventFindFirst.mockReset();
    db.calendarEventFindFirst.mockResolvedValue(null);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects an unauthenticated caller with 401", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: URL });
    await app.close();
    expect(res.statusCode).toBe(401);
    expect(db.automationConfigFindUnique).not.toHaveBeenCalled();
  });

  it("allows both banner kinds when the user has no settings row (defaults notify)", async () => {
    db.automationConfigFindUnique.mockResolvedValue(null);
    const res = await alertState();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ alerts: { push: ALLOWED, meeting: ALLOWED } });
  });

  it("treats absent category fields as on (schema defaults are true)", async () => {
    db.automationConfigFindUnique.mockResolvedValue({ timezone: "UTC" });
    expect((await alertState()).json()).toEqual({ alerts: { push: ALLOWED, meeting: ALLOWED } });
  });

  it("holds both kinds inside quiet hours, with the reason", async () => {
    db.automationConfigFindUnique.mockResolvedValue({
      timezone: "UTC",
      quietHoursStart: "22:00",
      quietHoursEnd: "08:00",
    });
    vi.setSystemTime(new Date("2026-11-08T03:00:00Z"));
    const quiet = { allowed: false, reason: "quiet_hours" };
    expect((await alertState()).json()).toEqual({ alerts: { push: quiet, meeting: quiet } });
  });

  it("lets both kinds through outside the quiet window", async () => {
    db.automationConfigFindUnique.mockResolvedValue({
      timezone: "UTC",
      quietHoursStart: "22:00",
      quietHoursEnd: "08:00",
    });
    vi.setSystemTime(new Date("2026-11-08T08:00:00Z")); // end minute is exclusive
    expect((await alertState()).json()).toEqual({ alerts: { push: ALLOWED, meeting: ALLOWED } });
  });

  it("evaluates quiet hours in the user's own time zone, not the server's", async () => {
    db.automationConfigFindUnique.mockResolvedValue({
      timezone: "Asia/Seoul",
      quietHoursStart: "22:00",
      quietHoursEnd: "08:00",
    });
    vi.setSystemTime(new Date("2026-11-07T15:30:00Z")); // 00:30 in Seoul
    expect((await alertState()).json().alerts.push).toEqual({
      allowed: false,
      reason: "quiet_hours",
    });
    vi.setSystemTime(new Date("2026-11-07T03:00:00Z")); // 12:00 in Seoul
    expect((await alertState()).json().alerts.push).toEqual(ALLOWED);
  });

  it("holds only PUSH-and-MEETING mail when Urgent email is off", async () => {
    db.automationConfigFindUnique.mockResolvedValue({ timezone: "UTC", notifyEmailUrgent: false });
    expect((await alertState()).json()).toEqual({
      alerts: { push: { allowed: false, reason: "user_preferences" }, meeting: ALLOWED },
    });
  });

  it("holds only the meeting-soon banner when Meetings is off", async () => {
    db.automationConfigFindUnique.mockResolvedValue({ timezone: "UTC", notifyMeeting: false });
    expect((await alertState()).json()).toEqual({
      alerts: { push: ALLOWED, meeting: { allowed: false, reason: "user_preferences" } },
    });
  });

  it("never holds urgent mail or meetings for a focus block (same rule as Web Push)", async () => {
    db.automationConfigFindUnique.mockResolvedValue({ timezone: "UTC", focusWindowEnabled: true });
    db.calendarEventFindFirst.mockResolvedValue({ id: "busy-1" });
    expect((await alertState()).json()).toEqual({ alerts: { push: ALLOWED, meeting: ALLOWED } });
  });

  it("reads only the caller's settings, whatever the query string says", async () => {
    db.automationConfigFindUnique.mockResolvedValue(null);
    await alertState(`${URL}?userId=user-2`);
    expect(db.automationConfigFindUnique).toHaveBeenCalled();
    for (const [args] of db.automationConfigFindUnique.mock.calls) {
      expect(args).toEqual({ where: { userId: "user-1" } });
    }
  });

  it("answers 503 without internals when the settings cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    db.automationConfigFindUnique.mockRejectedValue(new Error("connection refused at 10.0.0.5"));
    const res = await alertState();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "Alert state unavailable" });
    expect(res.body).not.toContain("10.0.0.5");
    error.mockRestore();
  });
});
