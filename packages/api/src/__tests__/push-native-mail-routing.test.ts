/**
 * sendPushNotification routes the mail deep-link ids (emailId, pendingActionId)
 * to the native senders only: the web push body and the Telegram payload are
 * exactly what they were (push-native-mail-payload.test.ts pins the native
 * shapes themselves).
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

const BASE = { title: "Klorn — Alice", body: "Q3 budget", url: "/inbox/firewall" };

// biome-ignore lint/suspicious/noExplicitAny: late-bound dynamic import
let sendPushNotification: any;

beforeAll(async () => {
  // push.ts reads VAPID env at module load, so the web-push send runs.
  process.env.VAPID_PUBLIC_KEY = "test-public-key";
  process.env.VAPID_PRIVATE_KEY = "test-private-key";
  ({ sendPushNotification } = await import("../notify/push.js"));
});

beforeEach(() => vi.clearAllMocks());

function webBody(): Record<string, unknown> {
  return JSON.parse((mocks.webPushSend.mock.calls[0] as unknown[])[1] as string);
}

describe("sendPushNotification — mail deep-link routing", () => {
  it("native senders get the mail ids; web push and Telegram get the payload as before", async () => {
    const mail = {
      ...BASE,
      attentionItemId: "item-1",
      emailId: "email-1",
      pendingActionId: "pa-1",
    };
    await sendPushNotification("user-1", mail, "email_urgent");

    expect(mocks.sendDevicePush).toHaveBeenCalledWith("user-1", mail, "email_urgent");
    expect(mocks.sendApnsPush).toHaveBeenCalledWith("user-1", mail, "email_urgent");

    const legacy = { ...BASE, attentionItemId: "item-1" };
    expect(mocks.sendTelegramForPush).toHaveBeenCalledWith("user-1", legacy, "email_urgent");
    const body = webBody();
    for (const key of ["emailId", "pendingActionId", "route"]) expect(body).not.toHaveProperty(key);
    expect(body).toMatchObject(legacy);
  });

  it("the bell notification id rides the web push body only (the SW's OS tag)", async () => {
    const { createPushDeliveryAttempt } = await import("../notify/push-delivery.js");
    await sendPushNotification(
      "user-1",
      { ...BASE, bellNotificationId: "notif-1", emailId: "email-1" },
      "email_urgent",
    );

    expect(webBody()).toMatchObject({ ...BASE, bellNotificationId: "notif-1" });
    // Native, Telegram: byte-identical to before.
    const native = { ...BASE, emailId: "email-1" };
    expect(mocks.sendDevicePush).toHaveBeenCalledWith("user-1", native, "email_urgent");
    expect(mocks.sendApnsPush).toHaveBeenCalledWith("user-1", native, "email_urgent");
    expect(mocks.sendTelegramForPush).toHaveBeenCalledWith("user-1", BASE, "email_urgent");
    // Not the delivery log's notificationId: phone escalation keys on that
    // column, and this display tag must not change who gets a call.
    expect(vi.mocked(createPushDeliveryAttempt)).toHaveBeenCalledWith(
      expect.objectContaining({ notificationId: null }),
    );
  });

  it("a push without mail ids reaches every channel exactly as before", async () => {
    await sendPushNotification("user-1", BASE, "system");
    expect(mocks.sendDevicePush).toHaveBeenCalledWith("user-1", BASE, "system");
    expect(mocks.sendApnsPush).toHaveBeenCalledWith("user-1", BASE, "system");
    expect(mocks.sendTelegramForPush).toHaveBeenCalledWith("user-1", BASE, "system");
    expect(Object.keys(webBody())).toEqual([...Object.keys(BASE), "deliveryId", "receiptUrl"]);
  });
});
