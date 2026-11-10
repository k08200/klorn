import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// sendTestPushToSubscription ("Send test" on one row of Where you get alerts):
// one push to one of the caller's own subscriptions. It skips the
// interrupt gates (quiet hours, category prefs, noise policy, push rate
// buckets) because the user explicitly asked, but keeps ownership, the origin
// allowlist, the SSRF endpoint check and the delivery log.
const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(async () => ({ failureCount: 1 })),
  remove: vi.fn(async () => ({})),
  createPushDeliveryAttempt: vi.fn(async () => "delivery-id"),
  markPushAccepted: vi.fn(async () => {}),
  markPushFailed: vi.fn(async () => {}),
  webPushSend: vi.fn(async () => ({})),
  gate: vi.fn(async () => ({ allowed: false, reason: "quiet_hours" })),
  policy: vi.fn(() => "noise"),
  rate: vi.fn(async () => ({ allowed: false, reason: "cap" })),
  originAllowed: vi.fn(() => true),
  safeEndpoint: vi.fn(() => true),
}));

vi.mock("../db.js", () => ({
  prisma: {
    pushSubscription: { findFirst: mocks.findFirst, update: mocks.update, delete: mocks.remove },
    pushDeliveryLog: { findFirst: vi.fn(async () => null) },
  },
}));
vi.mock("../notify/push-delivery.js", () => ({
  createPushDeliveryAttempt: mocks.createPushDeliveryAttempt,
  createSkippedPushDelivery: vi.fn(async () => {}),
  markPushAccepted: mocks.markPushAccepted,
  markPushFailed: mocks.markPushFailed,
}));
vi.mock("../notify/notification-policy.js", () => ({
  notificationSuppressionReason: mocks.policy,
}));
vi.mock("../notify/notification-prefs.js", () => ({ evaluateNotificationGate: mocks.gate }));
vi.mock("../notify/push-rate-limit.js", () => ({ recordPushAttempt: mocks.rate }));
vi.mock("../notify/is-safe-push-endpoint.js", () => ({ isSafePushEndpoint: mocks.safeEndpoint }));
vi.mock("../notify/push-origin-allowlist.js", () => ({ isAllowedPushOrigin: mocks.originAllowed }));
vi.mock("../notify/telegram-notify.js", () => ({ sendTelegramForPush: vi.fn() }));
vi.mock("../notify/push-device.js", () => ({ sendDevicePush: vi.fn() }));
vi.mock("../notify/push-apns.js", () => ({ sendApnsPush: vi.fn() }));
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: mocks.webPushSend },
  setVapidDetails: vi.fn(),
  sendNotification: mocks.webPushSend,
}));

const SUB = {
  id: "sub-1",
  endpoint: "https://fcm.googleapis.com/fcm/send/abc",
  p256dh: "p",
  auth: "a",
  origin: "https://app.klorn.ai",
  failureCount: 0,
};
const COPY = { title: "Klorn test alert", body: "Alerts reach this device.", url: "/settings" };

// biome-ignore lint/suspicious/noExplicitAny: late-bound dynamic import
let sendTestPushToSubscription: any;

beforeAll(async () => {
  process.env.VAPID_PUBLIC_KEY = "test-public-key";
  process.env.VAPID_PRIVATE_KEY = "test-private-key";
  ({ sendTestPushToSubscription } = await import("../notify/push.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findFirst.mockResolvedValue(SUB);
  mocks.originAllowed.mockReturnValue(true);
  mocks.safeEndpoint.mockReturnValue(true);
  mocks.webPushSend.mockResolvedValue({});
});

describe("sendTestPushToSubscription", () => {
  it("looks the subscription up by id AND the caller's user id", async () => {
    await sendTestPushToSubscription("user-1", "sub-1", COPY);
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { id: "sub-1", userId: "user-1" } });
  });

  it("answers not_found for someone else's (or a missing) subscription and sends nothing", async () => {
    mocks.findFirst.mockResolvedValue(null);
    expect(await sendTestPushToSubscription("user-2", "sub-1", COPY)).toEqual({
      status: "not_found",
    });
    expect(mocks.webPushSend).not.toHaveBeenCalled();
  });

  it("delivers despite quiet hours, muted categories, the noise policy and push buckets", async () => {
    const result = await sendTestPushToSubscription("user-1", "sub-1", COPY);
    expect(result).toEqual({ status: "sent", delivered: true });
    expect(mocks.webPushSend).toHaveBeenCalledTimes(1);
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.policy).not.toHaveBeenCalled();
    expect(mocks.rate).not.toHaveBeenCalled();
    const body = JSON.parse(mocks.webPushSend.mock.calls[0][1] as string);
    expect(body).toMatchObject(COPY);
    expect(mocks.markPushAccepted).toHaveBeenCalledWith("delivery-id");
  });

  it("logs the attempt against that subscription so its receipt counts", async () => {
    await sendTestPushToSubscription("user-1", "sub-1", COPY);
    expect(mocks.createPushDeliveryAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", subscriptionId: "sub-1", category: "system" }),
    );
  });

  it("still refuses a subscription from a retired origin", async () => {
    mocks.originAllowed.mockReturnValue(false);
    expect(await sendTestPushToSubscription("user-1", "sub-1", COPY)).toEqual({
      status: "skipped",
      reason: "origin_not_allowed",
      delivered: false,
    });
    expect(mocks.webPushSend).not.toHaveBeenCalled();
  });

  it("still refuses an endpoint that fails the SSRF check", async () => {
    mocks.safeEndpoint.mockReturnValue(false);
    expect(await sendTestPushToSubscription("user-1", "sub-1", COPY)).toMatchObject({
      status: "skipped",
      reason: "unsafe_endpoint",
    });
    expect(mocks.webPushSend).not.toHaveBeenCalled();
  });

  it("reports a rejected push as sent-but-not-delivered and evicts a gone endpoint", async () => {
    mocks.webPushSend.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));
    expect(await sendTestPushToSubscription("user-1", "sub-1", COPY)).toEqual({
      status: "sent",
      delivered: false,
    });
    expect(mocks.remove).toHaveBeenCalledWith({ where: { id: "sub-1" } });
  });
});
