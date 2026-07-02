import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mirror quiet-hours.test.ts: every collaborator of push.ts is mocked so the
// module graph never opens a real DB connection, and VAPID env is set before
// the dynamic import so the web-push send loop actually runs.
const mocks = vi.hoisted(() => ({
  pushSubscriptionFindMany: vi.fn(),
  pushSubscriptionUpdate: vi.fn(async () => ({ failureCount: 1 })),
  pushSubscriptionDelete: vi.fn(async () => ({})),
  createPushDeliveryAttempt: vi.fn(async () => "delivery-id"),
  createSkippedPushDelivery: vi.fn(async () => {}),
  markPushAccepted: vi.fn(async () => {}),
  markPushFailed: vi.fn(async () => {}),
  webPushSend: vi.fn(async () => ({})),
}));

vi.mock("../db.js", () => ({
  prisma: {
    pushSubscription: {
      findMany: mocks.pushSubscriptionFindMany,
      update: mocks.pushSubscriptionUpdate,
      delete: mocks.pushSubscriptionDelete,
    },
    pushDeliveryLog: { findFirst: vi.fn(async () => null) },
  },
}));
vi.mock("../push-delivery.js", () => ({
  createPushDeliveryAttempt: mocks.createPushDeliveryAttempt,
  createSkippedPushDelivery: mocks.createSkippedPushDelivery,
  markPushAccepted: mocks.markPushAccepted,
  markPushFailed: mocks.markPushFailed,
}));
vi.mock("../notification-policy.js", () => ({
  notificationSuppressionReason: vi.fn(() => null),
}));
vi.mock("../notification-prefs.js", () => ({
  evaluateNotificationGate: vi.fn(async () => ({ allowed: true as const })),
}));
vi.mock("../push-rate-limit.js", () => ({
  recordPushAttempt: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("../is-safe-push-endpoint.js", () => ({
  isSafePushEndpoint: vi.fn(() => true),
}));
vi.mock("../push-origin-allowlist.js", () => ({
  isAllowedPushOrigin: vi.fn(() => true),
}));
vi.mock("../telegram-notify.js", () => ({
  sendTelegramForPush: vi.fn(async () => "sent"),
}));
vi.mock("../push-device.js", () => ({
  sendDevicePush: vi.fn(async () => ({ status: "skipped" })),
}));
vi.mock("../push-apns.js", () => ({
  sendApnsPush: vi.fn(async () => ({ status: "skipped" })),
}));
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: mocks.webPushSend },
  setVapidDetails: vi.fn(),
  sendNotification: mocks.webPushSend,
}));

const USER_ID = "user-1";
const PAYLOAD = { title: "Urgent mail", body: "Reply needed", url: "/briefing" };

function subscription(id: string) {
  return {
    id,
    endpoint: `https://push.example.com/${id}`,
    p256dh: "p256dh-key",
    auth: "auth-key",
    origin: "http://localhost:8001",
    failureCount: 0,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: late-bound dynamic import
let sendPushNotification: any;

beforeAll(async () => {
  // push.ts reads VAPID env at module load — set before importing so the
  // web-push send fan-out actually runs.
  process.env.VAPID_PUBLIC_KEY = "test-public-key";
  process.env.VAPID_PRIVATE_KEY = "test-private-key";
  ({ sendPushNotification } = await import("../push.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.webPushSend.mockResolvedValue({});
  mocks.pushSubscriptionUpdate.mockResolvedValue({ failureCount: 1 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("sendPushNotification — bounded-concurrency fan-out", () => {
  it("sends to every subscription (all attempted, correct counts)", async () => {
    const subs = ["a", "b", "c", "d", "e", "f", "g", "h"].map(subscription);
    mocks.pushSubscriptionFindMany.mockResolvedValue(subs);

    const result = await sendPushNotification(USER_ID, PAYLOAD, "email_urgent");

    expect(result.status).toBe("sent");
    expect(result.subscriptions).toBe(subs.length);
    expect(result.attempted).toBe(subs.length);
    expect(result.accepted).toBe(subs.length);
    expect(result.failed).toBe(0);
    expect(mocks.webPushSend).toHaveBeenCalledTimes(subs.length);
  });

  it("isolates a throwing subscription — the rest still get sent", async () => {
    const subs = ["a", "b", "c"].map(subscription);
    mocks.pushSubscriptionFindMany.mockResolvedValue(subs);
    // The send for sub "b" throws a permanent (non-retryable) 400 so it fails
    // once without retrying; "a" and "c" succeed.
    mocks.webPushSend.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith("/b")) {
        throw Object.assign(new Error("boom"), { statusCode: 400, body: "bad" });
      }
      return {};
    });

    const result = await sendPushNotification(USER_ID, PAYLOAD, "email_urgent");

    expect(result.status).toBe("sent");
    expect(result.attempted).toBe(3);
    expect(result.accepted).toBe(2); // a + c
    expect(result.failed).toBe(1); // b
    // All three were attempted despite b throwing.
    expect(mocks.webPushSend).toHaveBeenCalledTimes(3);
    expect(mocks.markPushAccepted).toHaveBeenCalledTimes(2);
    expect(mocks.markPushFailed).toHaveBeenCalledTimes(1);
  });
});

describe("sendPushNotification — topic header (ambiguous-retry dedup)", () => {
  it("passes a stable { topic } option derived from the deliveryId", async () => {
    mocks.pushSubscriptionFindMany.mockResolvedValue([subscription("a")]);

    await sendPushNotification(USER_ID, PAYLOAD, "email_urgent");

    expect(mocks.webPushSend).toHaveBeenCalledTimes(1);
    const options = mocks.webPushSend.mock.calls[0][2];
    expect(options).toBeDefined();
    expect(typeof options.topic).toBe("string");
    expect(options.topic.length).toBeGreaterThan(0);
    expect(options.topic.length).toBeLessThanOrEqual(32);
    // URL/filename-safe base64url: no +, /, or = padding.
    expect(options.topic).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("uses the same topic across retries of one subscription (deliveryId stable)", async () => {
    mocks.pushSubscriptionFindMany.mockResolvedValue([subscription("a")]);
    // First attempt: transient 503 (retryable) → retry; second attempt succeeds.
    mocks.webPushSend
      .mockRejectedValueOnce(Object.assign(new Error("blip"), { statusCode: 503 }))
      .mockResolvedValueOnce({});

    // The transient-failure path does a real await sleep(3000ms); run it under
    // fake timers so the test doesn't wait 3s of wall clock.
    vi.useFakeTimers();
    const promise = sendPushNotification(USER_ID, PAYLOAD, "email_urgent");
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();

    expect(mocks.webPushSend).toHaveBeenCalledTimes(2);
    const topic1 = mocks.webPushSend.mock.calls[0][2].topic;
    const topic2 = mocks.webPushSend.mock.calls[1][2].topic;
    expect(topic1).toBe(topic2);
  });
});

describe("sendPushNotification — eviction path preserved", () => {
  it("deletes a subscription on a 410 Gone response", async () => {
    mocks.pushSubscriptionFindMany.mockResolvedValue([subscription("gone")]);
    mocks.webPushSend.mockRejectedValue(
      Object.assign(new Error("gone"), { statusCode: 410, body: "gone" }),
    );

    const result = await sendPushNotification(USER_ID, PAYLOAD, "email_urgent");

    expect(result.failed).toBe(1);
    expect(result.accepted).toBe(0);
    expect(mocks.pushSubscriptionDelete).toHaveBeenCalledWith({ where: { id: "gone" } });
  });
});
