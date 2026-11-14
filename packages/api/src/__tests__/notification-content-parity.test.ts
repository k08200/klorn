/**
 * One notification, one content (founder requirement, NC1): web push, FCM,
 * APNs, Telegram and the live desktop frame all carry mailPushContent's
 * title (the sender) and body (the subject, then the verified quote or the
 * short reason). Every channel's delivery row names the bell row it rang for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  subFindMany: vi.fn(),
  createPushDeliveryAttempt: vi.fn(async () => "delivery-1"),
  recordChannelSend: vi.fn(async () => "row-1"),
  webPushSend: vi.fn(async () => ({})),
  telegram: vi.fn(async () => "sent"),
  fcm: vi.fn(async () => ({ status: "sent", tokens: 1, accepted: 1, failed: 0 })),
  apns: vi.fn(async () => ({ status: "sent", tokens: 1, accepted: 1, failed: 0 })),
}));

vi.mock("../db.js", () => ({
  prisma: {
    pushSubscription: {
      findMany: mocks.subFindMany,
      update: vi.fn(async () => ({ failureCount: 0 })),
    },
    pushDeliveryLog: { findFirst: vi.fn(async () => null) },
  },
}));
vi.mock("../notify/push-delivery.js", () => ({
  createPushDeliveryAttempt: mocks.createPushDeliveryAttempt,
  createSkippedPushDelivery: vi.fn(async () => {}),
  markPushAccepted: vi.fn(async () => {}),
  markPushFailed: vi.fn(async () => {}),
}));
vi.mock("../notify/push-zombie.js", () => ({
  evaluateZombieSubscription: vi.fn(async () => false),
}));
vi.mock("../notify/channel-delivery-log.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../notify/channel-delivery-log.js")>();
  return { nativeSendOutcome: real.nativeSendOutcome, recordChannelSend: mocks.recordChannelSend };
});
vi.mock("../notify/notification-prefs.js", () => ({
  evaluateNotificationGate: vi.fn(async () => ({ allowed: true as const })),
}));
vi.mock("../notify/push-rate-limit.js", () => ({
  recordPushAttempt: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("../notify/is-safe-push-endpoint.js", () => ({ isSafePushEndpoint: vi.fn(() => true) }));
vi.mock("../notify/push-origin-allowlist.js", () => ({ isAllowedPushOrigin: vi.fn(() => true) }));
vi.mock("../notify/telegram-notify.js", () => ({ sendTelegramForPush: mocks.telegram }));
vi.mock("../notify/push-device.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../notify/push-device.js")>()),
  sendDevicePush: mocks.fcm,
}));
vi.mock("../notify/push-apns.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../notify/push-apns.js")>()),
  sendApnsPush: mocks.apns,
}));
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: mocks.webPushSend },
  setVapidDetails: vi.fn(),
  sendNotification: mocks.webPushSend,
}));

import { mailPushContent } from "../notify/mail-push-content.js";

const USER = "user-1";
const CONTENT = mailPushContent({
  from: "Alice Kim <alice@example.com>",
  subject: "Contract <b>renewal</b>",
  reason: {
    text: "Signature needed today",
    verified: true,
    quote: "Please sign by 5pm today",
    quoteIn: "body",
  },
  language: "en",
});

async function loadPush() {
  vi.resetModules();
  process.env.VAPID_PUBLIC_KEY = "pub";
  process.env.VAPID_PRIVATE_KEY = "priv";
  return import("../notify/push.js");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.subFindMany.mockResolvedValue([
    {
      id: "sub-1",
      endpoint: "https://fcm.googleapis.com/fcm/send/sub-1",
      p256dh: "p",
      auth: "a",
      origin: "https://app.klorn.ai",
      failureCount: 0,
      needsResubscribeAt: null,
    },
  ]);
});

afterEach(() => {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
});

describe("formatter parity across channels", () => {
  it("the formatter's output is the sender, then subject + verified quote, plain text", () => {
    expect(CONTENT).toEqual({
      title: "Alice Kim",
      body: "Contract renewal\n“Please sign by 5pm today”",
    });
  });

  it("web push, Telegram, FCM and APNs carry the same title and body", async () => {
    const { sendPushNotification } = await loadPush();
    await sendPushNotification(
      USER,
      {
        ...CONTENT,
        url: "/email/e1",
        attentionItemId: "item-1",
        lane: "PUSH",
        language: "en",
        emailId: "e1",
        bellNotificationId: "bell-1",
      },
      "email_urgent",
      { bucket: "interrupt" },
    );
    await vi.waitFor(() => expect(mocks.apns).toHaveBeenCalled());

    const telegramPayload = mocks.telegram.mock.calls[0]?.[1] as { title: string; body: string };
    const fcmPayload = mocks.fcm.mock.calls[0]?.[1] as { title: string; body: string };
    const apnsPayload = mocks.apns.mock.calls[0]?.[1] as { title: string; body: string };
    const webJson = JSON.parse(String(mocks.webPushSend.mock.calls[0]?.[1])) as {
      title: string;
      body: string;
    };

    for (const payload of [telegramPayload, fcmPayload, apnsPayload, webJson]) {
      expect({ title: payload.title, body: payload.body }).toEqual(CONTENT);
    }

    // What the native transports put on the device is that same content.
    const { buildApnsBody } = await import("../notify/push-apns.js");
    const { buildFcmMessage } = await import("../notify/push-device.js");
    expect(JSON.parse(buildApnsBody(apnsPayload as never, "email_urgent")).aps.alert).toEqual(
      CONTENT,
    );
    const fcm = buildFcmMessage("tok", fcmPayload as never, "email_urgent") as {
      notification?: { title: string; body: string };
    };
    expect(fcm.notification).toEqual(CONTENT);
  });

  it("every channel's delivery row names the bell row (and notificationId stays empty)", async () => {
    const { sendPushNotification } = await loadPush();
    await sendPushNotification(
      USER,
      { ...CONTENT, url: "/email/e1", emailId: "e1", lane: "PUSH", bellNotificationId: "bell-1" },
      "email_urgent",
      { bucket: "interrupt" },
    );
    await vi.waitFor(() => expect(mocks.recordChannelSend).toHaveBeenCalledTimes(3));

    expect(mocks.createPushDeliveryAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ bellNotificationId: "bell-1", notificationId: null }),
    );
    const channels = mocks.recordChannelSend.mock.calls.map(
      (c) => (c as unknown as [{ channel: string; bellNotificationId: string | null }])[0],
    );
    expect(channels.map((c) => c.channel).sort()).toEqual(["apns", "fcm", "telegram"]);
    for (const row of channels) {
      expect(row).toMatchObject({ bellNotificationId: "bell-1", notificationId: null });
    }
  });

  it("a push without a bell row writes no bell id", async () => {
    const { sendPushNotification } = await loadPush();
    await sendPushNotification(USER, { title: "Daily briefing", body: "3 things" }, "system");
    await vi.waitFor(() => expect(mocks.recordChannelSend).toHaveBeenCalledTimes(3));
    expect(mocks.createPushDeliveryAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ bellNotificationId: null }),
    );
    for (const call of mocks.recordChannelSend.mock.calls) {
      expect((call as unknown as [{ bellNotificationId: unknown }])[0].bellNotificationId).toBe(
        null,
      );
    }
  });
});
