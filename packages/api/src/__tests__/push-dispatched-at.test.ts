/**
 * sendPushNotification reports WHEN a push got past every hold gate (the noise
 * policy, the user's category preferences and quiet hours, the agent-proposal
 * cooldown and the per-user rate limit) and was handed to the user's channels.
 * That instant is the "ring" IP24 counts (DecisionLabel.rangAt), the same
 * instant the rate limiter writes its PushRingEvent. A push held at a gate
 * reports null. What happens after the gates (no browser subscription, no
 * VAPID keys) is a reach question, not a hold, so it still reports the time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  suppression: vi.fn((): string | null => null),
  gate: vi.fn(
    async (): Promise<{ allowed: true } | { allowed: false; reason: string }> => ({
      allowed: true,
    }),
  ),
  rate: vi.fn(async (): Promise<{ allowed: boolean; reason?: string }> => ({ allowed: true })),
}));

const subs = vi.hoisted(() => ({ findMany: vi.fn(async (): Promise<unknown[]> => []) }));

vi.mock("../db.js", () => ({
  prisma: {
    pushSubscription: {
      findMany: subs.findMany,
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
    pushDeliveryLog: { findFirst: vi.fn(async () => null) },
  },
}));
vi.mock("../analytics.js", () => ({ recordEvent: vi.fn(async () => {}) }));
vi.mock("../notify/push-origin-allowlist.js", () => ({ isAllowedPushOrigin: () => true }));
vi.mock("../notify/is-safe-push-endpoint.js", () => ({ isSafePushEndpoint: () => true }));
vi.mock("../notify/push-delivery.js", () => ({
  createPushDeliveryAttempt: vi.fn(async () => "delivery-id"),
  createSkippedPushDelivery: vi.fn(async () => {}),
  markPushAccepted: vi.fn(async () => {}),
  markPushFailed: vi.fn(async () => {}),
}));
vi.mock("../notify/notification-policy.js", () => ({
  notificationSuppressionReason: m.suppression,
}));
vi.mock("../notify/notification-prefs.js", () => ({ evaluateNotificationGate: m.gate }));
vi.mock("../notify/push-rate-limit.js", () => ({ recordPushAttempt: m.rate }));
vi.mock("../notify/push-device.js", () => ({ sendDevicePush: vi.fn(async () => ({})) }));
vi.mock("../notify/push-apns.js", () => ({ sendApnsPush: vi.fn(async () => ({})) }));
vi.mock("../notify/telegram-notify.js", () => ({
  sendTelegramForPush: vi.fn(async () => "skipped"),
}));
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() },
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
}));

import { sendPushNotification } from "../notify/push.js";

const ring = () =>
  sendPushNotification("user-1", { title: "T", body: "B" }, "email_urgent", {
    bucket: "interrupt",
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  m.suppression.mockReturnValue(null);
  m.gate.mockResolvedValue({ allowed: true });
  m.rate.mockResolvedValue({ allowed: true });
  subs.findMany.mockResolvedValue([]);
});

afterEach(() => {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
});

/** push.ts reads its VAPID keys at load: load a copy that has them. */
async function pushWithVapid() {
  process.env.VAPID_PUBLIC_KEY = "test-public-key";
  process.env.VAPID_PRIVATE_KEY = "test-private-key";
  vi.resetModules();
  return import("../notify/push.js");
}

const SUBSCRIPTION = {
  id: "sub-1",
  endpoint: "https://fcm.googleapis.com/fcm/send/abc",
  p256dh: "p",
  auth: "a",
  origin: "https://app.klorn.ai",
  failureCount: 0,
};

describe("sendPushNotification dispatchedAt", () => {
  it("is null when the noise policy suppresses the push", async () => {
    m.suppression.mockReturnValue("housekeeping");
    expect((await ring()).dispatchedAt).toBeNull();
  });

  it("is null when quiet hours or a category opt-out hold the push", async () => {
    m.gate.mockResolvedValue({ allowed: false, reason: "quiet_hours" });
    expect((await ring()).dispatchedAt).toBeNull();
  });

  it("is null when the rate limit holds the push", async () => {
    m.rate.mockResolvedValue({ allowed: false, reason: "10min" });
    const summary = await ring();
    expect(summary.reason).toBe("rate_limited");
    expect(summary.dispatchedAt).toBeNull();
  });

  it("is the dispatch time once every gate passed, even with no web channel to reach", async () => {
    const before = Date.now();
    const summary = await ring();
    // VAPID is unset under test, so the web leg ends here; the ring still went
    // to every channel the user has (Telegram, the native apps).
    expect(summary.reason).toBe("missing_vapid_keys");
    expect(summary.dispatchedAt).toBeInstanceOf(Date);
    expect(summary.dispatchedAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(summary.dispatchedAt?.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("is the dispatch time when the user has no browser subscription (reach, not a hold)", async () => {
    const push = await pushWithVapid();
    const summary = await push.sendPushNotification(
      "user-1",
      { title: "T", body: "B" },
      "email_urgent",
      {
        bucket: "interrupt",
      },
    );
    expect(summary.reason).toBe("no_subscriptions");
    expect(summary.dispatchedAt).toBeInstanceOf(Date);
  });

  it("is the dispatch time on a sent push", async () => {
    subs.findMany.mockResolvedValue([SUBSCRIPTION]);
    const push = await pushWithVapid();
    const summary = await push.sendPushNotification(
      "user-1",
      { title: "T", body: "B" },
      "email_urgent",
      {
        bucket: "interrupt",
      },
    );
    expect(summary.status).toBe("sent");
    expect(summary.accepted).toBe(1);
    expect(summary.dispatchedAt).toBeInstanceOf(Date);
  });
});
