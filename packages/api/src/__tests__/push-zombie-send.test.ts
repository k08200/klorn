import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// push.ts on the delivery lifecycle: web push rows get queuedAt with the
// settled send; an accepted push re-evaluates the zombie run (only when pushes
// carry a receipt URL); PUSH_ZOMBIE_EVICTION stops sends to a flagged
// subscription while "Send test" still reaches it; FCM / APNs / Telegram
// attempts are recorded per channel.
const mocks = vi.hoisted(() => ({
  subFindMany: vi.fn(),
  subFindFirst: vi.fn(),
  subUpdate: vi.fn(async () => ({ failureCount: 1 })),
  subDelete: vi.fn(async () => ({})),
  createPushDeliveryAttempt: vi.fn(async () => "delivery-1"),
  createSkippedPushDelivery: vi.fn(async () => {}),
  markPushAccepted: vi.fn(async () => {}),
  markPushFailed: vi.fn(async () => {}),
  webPushSend: vi.fn(async () => ({})),
  evaluateZombieSubscription: vi.fn(async () => false),
  recordChannelSend: vi.fn(async () => "row-1"),
  telegram: vi.fn(async () => "skipped"),
  fcm: vi.fn(async () => ({ status: "skipped", reason: "no_device_tokens" })),
  apns: vi.fn(async () => ({ status: "skipped", reason: "no_device_tokens" })),
}));

vi.mock("../db.js", () => ({
  prisma: {
    pushSubscription: {
      findMany: mocks.subFindMany,
      findFirst: mocks.subFindFirst,
      update: mocks.subUpdate,
      delete: mocks.subDelete,
    },
    pushDeliveryLog: { findFirst: vi.fn(async () => null) },
  },
}));
vi.mock("../notify/push-delivery.js", () => ({
  createPushDeliveryAttempt: mocks.createPushDeliveryAttempt,
  createSkippedPushDelivery: mocks.createSkippedPushDelivery,
  markPushAccepted: mocks.markPushAccepted,
  markPushFailed: mocks.markPushFailed,
}));
vi.mock("../notify/push-zombie.js", () => ({
  evaluateZombieSubscription: mocks.evaluateZombieSubscription,
}));
vi.mock("../notify/channel-delivery-log.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../notify/channel-delivery-log.js")>();
  return { nativeSendOutcome: real.nativeSendOutcome, recordChannelSend: mocks.recordChannelSend };
});
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
vi.mock("../notify/telegram-notify.js", () => ({ sendTelegramForPush: mocks.telegram }));
vi.mock("../notify/push-device.js", () => ({ sendDevicePush: mocks.fcm }));
vi.mock("../notify/push-apns.js", () => ({ sendApnsPush: mocks.apns }));
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: mocks.webPushSend },
  setVapidDetails: vi.fn(),
  sendNotification: mocks.webPushSend,
}));

const PAYLOAD = {
  title: "Klorn — Ada",
  body: "Contract",
  url: "/mail/e1",
  notificationId: "bell-1",
};

function sub(id: string, needsResubscribeAt: Date | null = null) {
  return {
    id,
    endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
    p256dh: "p",
    auth: "a",
    origin: "https://app.klorn.ai",
    failureCount: 0,
    needsResubscribeAt,
  };
}

type PushModule = typeof import("../notify/push.js");

async function loadPush(receiptBase: string | undefined): Promise<PushModule> {
  vi.resetModules();
  process.env.VAPID_PUBLIC_KEY = "pub";
  process.env.VAPID_PRIVATE_KEY = "priv";
  if (receiptBase) process.env.PUSH_RECEIPT_BASE_URL = receiptBase;
  else delete process.env.PUSH_RECEIPT_BASE_URL;
  delete process.env.RENDER_EXTERNAL_URL;
  return import("../notify/push.js");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.subFindMany.mockResolvedValue([sub("sub-1")]);
  mocks.webPushSend.mockResolvedValue({});
  mocks.telegram.mockResolvedValue("skipped");
  mocks.fcm.mockResolvedValue({ status: "skipped", reason: "no_device_tokens" });
  mocks.apns.mockResolvedValue({ status: "skipped", reason: "no_device_tokens" });
});

afterEach(() => {
  delete process.env.PUSH_ZOMBIE_EVICTION;
  delete process.env.PUSH_RECEIPT_BASE_URL;
});

describe("web push lifecycle", () => {
  it("stamps queuedAt with the accepted send", async () => {
    const { sendPushNotification } = await loadPush("https://api.example.com");
    await sendPushNotification("user-1", PAYLOAD, "email_urgent");
    const [id, acceptedAt, queuedAt] = mocks.markPushAccepted.mock.calls[0];
    expect(id).toBe("delivery-1");
    expect(acceptedAt).toBeInstanceOf(Date);
    expect(queuedAt).toBeInstanceOf(Date);
    expect((queuedAt as Date).getTime()).toBeLessThanOrEqual((acceptedAt as Date).getTime());
  });

  it("re-evaluates the zombie run after an accepted push when receipts are wired", async () => {
    const { sendPushNotification } = await loadPush("https://api.example.com");
    await sendPushNotification("user-1", PAYLOAD, "email_urgent");
    expect(mocks.evaluateZombieSubscription).toHaveBeenCalledWith("sub-1", expect.any(Date), null);
  });

  it("passes when the endpoint last changed, so the run restarts from there", async () => {
    const since = new Date("2026-11-01T00:00:00Z");
    mocks.subFindMany.mockResolvedValue([{ ...sub("sub-1"), endpointSince: since }]);
    const { sendPushNotification } = await loadPush("https://api.example.com");
    await sendPushNotification("user-1", PAYLOAD, "email_urgent");
    expect(mocks.evaluateZombieSubscription.mock.calls[0][2]).toEqual(since);
  });

  it("never evaluates without a receipt URL: every subscription would look dead", async () => {
    const { sendPushNotification } = await loadPush(undefined);
    await sendPushNotification("user-1", PAYLOAD, "email_urgent");
    expect(mocks.markPushAccepted).toHaveBeenCalled();
    expect(mocks.evaluateZombieSubscription).not.toHaveBeenCalled();
  });

  it("does not let a zombie evaluation failure fail the push", async () => {
    mocks.evaluateZombieSubscription.mockRejectedValueOnce(new Error("db"));
    const { sendPushNotification } = await loadPush("https://api.example.com");
    const summary = await sendPushNotification("user-1", PAYLOAD, "email_urgent");
    expect(summary).toMatchObject({ status: "sent", accepted: 1 });
  });
});

describe("PUSH_ZOMBIE_EVICTION", () => {
  it("off (default): a flagged subscription still gets pushes", async () => {
    mocks.subFindMany.mockResolvedValue([sub("sub-1", new Date())]);
    const { sendPushNotification } = await loadPush("https://api.example.com");
    const summary = await sendPushNotification("user-1", PAYLOAD, "email_urgent");
    expect(summary).toMatchObject({ status: "sent", attempted: 1 });
  });

  it("on: sends only to unflagged subscriptions", async () => {
    process.env.PUSH_ZOMBIE_EVICTION = "true";
    mocks.subFindMany.mockResolvedValue([sub("sub-1", new Date()), sub("sub-2")]);
    const { sendPushNotification } = await loadPush("https://api.example.com");
    const summary = await sendPushNotification("user-1", PAYLOAD, "email_urgent");
    expect(summary).toMatchObject({ status: "sent", subscriptions: 1, attempted: 1 });
    expect(mocks.webPushSend).toHaveBeenCalledTimes(1);
    expect(mocks.webPushSend.mock.calls[0][0].endpoint).toContain("sub-2");
  });

  it("on: records why nothing was sent when every subscription is flagged", async () => {
    process.env.PUSH_ZOMBIE_EVICTION = "true";
    mocks.subFindMany.mockResolvedValue([sub("sub-1", new Date())]);
    const { sendPushNotification } = await loadPush("https://api.example.com");
    const summary = await sendPushNotification("user-1", PAYLOAD, "email_urgent");
    expect(summary).toMatchObject({ status: "skipped", reason: "subscriptions_need_resubscribe" });
    expect(mocks.webPushSend).not.toHaveBeenCalled();
    expect(mocks.createSkippedPushDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ skipReason: "subscriptions_need_resubscribe" }),
    );
  });

  it("on: Send test still reaches a flagged subscription, and returns its delivery id", async () => {
    process.env.PUSH_ZOMBIE_EVICTION = "true";
    mocks.subFindFirst.mockResolvedValue(sub("sub-1", new Date()));
    const { sendTestPushToSubscription } = await loadPush("https://api.example.com");
    const result = await sendTestPushToSubscription("user-1", "sub-1", {
      title: "t",
      body: "b",
      url: "/settings",
    });
    expect(result).toEqual({ status: "sent", delivered: true, deliveryId: "delivery-1" });
  });
});

describe("FCM / APNs / Telegram attempts", () => {
  it("records an accepted FCM send against the bell row", async () => {
    mocks.fcm.mockResolvedValue({ status: "sent", tokens: 1, accepted: 1, failed: 0 });
    const { sendPushNotification } = await loadPush("https://api.example.com");
    await sendPushNotification("user-1", PAYLOAD, "email_urgent");
    await vi.waitFor(() => expect(mocks.recordChannelSend).toHaveBeenCalled());
    expect(mocks.recordChannelSend).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        channel: "fcm",
        notificationId: "bell-1",
        category: "email_urgent",
        outcome: { status: "sent" },
        queuedAt: expect.any(Date),
      }),
    );
  });

  it("records a failed APNs send and nothing for a channel with no tokens", async () => {
    mocks.apns.mockResolvedValue({ status: "skipped", reason: "apns_connect_error" });
    const { sendPushNotification } = await loadPush("https://api.example.com");
    await sendPushNotification("user-1", PAYLOAD, "email_urgent");
    await vi.waitFor(() => expect(mocks.recordChannelSend).toHaveBeenCalled());
    expect(mocks.recordChannelSend).toHaveBeenCalledTimes(1);
    expect(mocks.recordChannelSend.mock.calls[0][0]).toMatchObject({
      channel: "apns",
      outcome: { status: "failed", reason: "apns_connect_error" },
    });
  });

  it("records a Telegram send that went out, and none for an unlinked chat", async () => {
    mocks.telegram.mockResolvedValue("sent");
    const { sendPushNotification } = await loadPush("https://api.example.com");
    await sendPushNotification("user-1", PAYLOAD, "email_urgent");
    expect(mocks.recordChannelSend).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", outcome: { status: "sent" } }),
    );

    vi.clearAllMocks();
    mocks.subFindMany.mockResolvedValue([sub("sub-1")]);
    mocks.telegram.mockResolvedValue("skipped");
    mocks.fcm.mockResolvedValue({ status: "skipped", reason: "no_device_tokens" });
    mocks.apns.mockResolvedValue({ status: "skipped", reason: "no_device_tokens" });
    await sendPushNotification("user-1", PAYLOAD, "email_urgent");
    expect(mocks.recordChannelSend).not.toHaveBeenCalled();
  });
});
