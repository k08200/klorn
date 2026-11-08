/**
 * Decision N1, delivery side: a mail push that names its lane carries the web
 * notification actions (Reply, Later), the reply path and a Later capability
 * scoped to that mail. The native channels get the lane (APNs picks the
 * MEETING action set from it). Silent / Mute and the tier-override token are
 * gone from the web payload.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  webPushSend: vi.fn(async () => ({})),
  sendDevicePush: vi.fn(async () => ({ status: "skipped" })),
  sendApnsPush: vi.fn(async () => ({ status: "skipped" })),
  sendTelegramForPush: vi.fn(async () => "sent"),
}));

vi.mock("../db.js", () => ({
  prisma: {
    pushSubscription: {
      findMany: vi.fn(async () => [
        {
          id: "sub-1",
          endpoint: "https://push.example.com/sub-1",
          p256dh: "p",
          auth: "a",
          origin: "http://localhost:8001",
          failureCount: 0,
        },
      ]),
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
    pushDeliveryLog: { findFirst: vi.fn(async () => null) },
  },
}));
vi.mock("../notify/push-delivery.js", () => ({
  createPushDeliveryAttempt: vi.fn(async () => "delivery-id"),
  createSkippedPushDelivery: vi.fn(async () => {}),
  markPushAccepted: vi.fn(async () => {}),
  markPushFailed: vi.fn(async () => {}),
}));
vi.mock("../notify/notification-policy.js", () => ({
  notificationSuppressionReason: vi.fn(() => null),
}));
vi.mock("../notify/notification-prefs.js", () => ({
  evaluateNotificationGate: vi.fn(async () => ({ allowed: true as const })),
}));
vi.mock("../notify/push-rate-limit.js", () => ({
  recordPushAttempt: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("../notify/is-safe-push-endpoint.js", () => ({ isSafePushEndpoint: vi.fn(() => true) }));
vi.mock("../notify/push-origin-allowlist.js", () => ({ isAllowedPushOrigin: vi.fn(() => true) }));
vi.mock("../notify/telegram-notify.js", () => ({ sendTelegramForPush: mocks.sendTelegramForPush }));
vi.mock("../notify/push-device.js", () => ({ sendDevicePush: mocks.sendDevicePush }));
vi.mock("../notify/push-apns.js", () => ({ sendApnsPush: mocks.sendApnsPush }));
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: mocks.webPushSend },
  setVapidDetails: vi.fn(),
  sendNotification: mocks.webPushSend,
}));

const API = "https://api.klorn.test";
const MAIL = {
  title: "Alice",
  body: "Contract\nSignature needed today",
  url: "/email/email-1",
  attentionItemId: "item-1",
  emailId: "email-1",
  bellNotificationId: "notif-1",
};

// biome-ignore lint/suspicious/noExplicitAny: late-bound dynamic import
let sendPushNotification: any;
// biome-ignore lint/suspicious/noExplicitAny: late-bound dynamic import
let verifyPushLaterToken: any;

beforeAll(async () => {
  process.env.VAPID_PUBLIC_KEY = "test-public-key";
  process.env.VAPID_PRIVATE_KEY = "test-private-key";
  process.env.PUSH_RECEIPT_BASE_URL = `${API}/`;
  ({ sendPushNotification } = await import("../notify/push.js"));
  ({ verifyPushLaterToken } = await import("../notify/push-later-token.js"));
});

beforeEach(() => vi.clearAllMocks());

function webBody(): Record<string, unknown> {
  return JSON.parse((mocks.webPushSend.mock.calls[0] as unknown[])[1] as string);
}

describe("web push payload of a lane-tagged mail push", () => {
  it("a PUSH mail carries Reply + Later, the reply path and a Later token for that mail", async () => {
    await sendPushNotification("user-1", { ...MAIL, lane: "PUSH", language: "ko" }, "email_urgent");

    const body = webBody();
    expect(body.title).toBe("Alice");
    expect(body.body).toBe("Contract\nSignature needed today");
    expect(body.url).toBe("/email/email-1");
    expect(body.actions).toEqual([
      { action: "reply", title: "답장" },
      { action: "later", title: "나중에" },
    ]);
    expect(body.replyUrl).toBe("/email/email-1?focus=reply");
    expect(body.laterUrl).toBe(`${API}/api/notifications/push/later`);
    expect(verifyPushLaterToken(body.laterToken)).toEqual({ userId: "user-1", emailId: "email-1" });
    // No silencing / retiering capability rides a web push any more.
    expect(body).not.toHaveProperty("overrideToken");
    expect(body).not.toHaveProperty("overrideUrl");
    // Internal routing fields never reach the service worker.
    for (const key of ["emailId", "lane", "language"]) expect(body).not.toHaveProperty(key);
  });

  it("a MEETING mail carries Later only", async () => {
    await sendPushNotification(
      "user-1",
      { ...MAIL, lane: "MEETING", language: "en" },
      "email_urgent",
    );
    const body = webBody();
    expect(body.actions).toEqual([{ action: "later", title: "Later" }]);
    expect(body).not.toHaveProperty("replyUrl");
    expect(typeof body.laterToken).toBe("string");
  });

  it("a push without a lane gets no action buttons (not even with mail and item ids)", async () => {
    await sendPushNotification("user-1", MAIL, "email_urgent");
    const body = webBody();
    for (const key of ["actions", "laterToken", "laterUrl", "replyUrl", "overrideToken"]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it("native senders get the lane; Telegram's payload does not change shape", async () => {
    await sendPushNotification(
      "user-1",
      { ...MAIL, lane: "MEETING", language: "en" },
      "email_urgent",
    );
    expect(mocks.sendApnsPush).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ emailId: "email-1", lane: "MEETING" }),
      "email_urgent",
    );
    expect(mocks.sendDevicePush).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ emailId: "email-1", lane: "MEETING" }),
      "email_urgent",
    );
    const telegram = (mocks.sendTelegramForPush.mock.calls[0] as unknown[])[1] as Record<
      string,
      unknown
    >;
    for (const key of ["lane", "language", "emailId"]) expect(telegram).not.toHaveProperty(key);
  });
});
