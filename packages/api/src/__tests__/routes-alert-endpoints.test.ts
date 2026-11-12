// N8 "Where you get alerts": GET list + per-endpoint "Send test" / "Remove".
// Pins auth, per-user scoping on every query, the user-keyed rate limit on test
// sends, and that no endpoint URL / token leaves the server.
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const mocks = vi.hoisted(() => ({
  subFindMany: vi.fn(),
  subFindFirst: vi.fn(),
  subDeleteMany: vi.fn(async () => ({ count: 1 })),
  tokenFindMany: vi.fn(),
  tokenFindFirst: vi.fn(),
  tokenDeleteMany: vi.fn(async () => ({ count: 1 })),
  logGroupBy: vi.fn(),
  sendTestPushToSubscription: vi.fn(),
  sendDevicePush: vi.fn(),
  sendApnsPush: vi.fn(),
  presenceList: vi.fn(() => []),
  recordChannelSend: vi.fn(async () => "row-9"),
  getDeliveryStatus: vi.fn(),
  userFindUnique: vi.fn(async () => ({ id: "user-1", telegramChatId: null })),
  telegramConfigured: vi.fn(() => true),
}));

vi.mock("../db.js", () => {
  const prisma = {
    pushSubscription: {
      findMany: mocks.subFindMany,
      findFirst: mocks.subFindFirst,
      deleteMany: mocks.subDeleteMany,
    },
    devicePushToken: {
      findMany: mocks.tokenFindMany,
      findFirst: mocks.tokenFindFirst,
      deleteMany: mocks.tokenDeleteMany,
    },
    pushDeliveryLog: { groupBy: mocks.logGroupBy },
    user: { findUnique: mocks.userFindUnique },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../notify/push.js", () => ({
  sendTestPushToSubscription: mocks.sendTestPushToSubscription,
}));
vi.mock("../notify/push-device.js", () => ({ sendDevicePush: mocks.sendDevicePush }));
vi.mock("../notify/push-apns.js", () => ({ sendApnsPush: mocks.sendApnsPush }));
vi.mock("../notify/desktop-presence.js", () => ({
  desktopPresence: { list: mocks.presenceList },
}));
vi.mock("../notify/channel-delivery-log.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../notify/channel-delivery-log.js")>();
  return {
    nativeSendOutcome: real.nativeSendOutcome,
    recordChannelSend: mocks.recordChannelSend,
    getDeliveryStatus: mocks.getDeliveryStatus,
  };
});
vi.mock("../notify/telegram.js", () => ({ isTelegramConfigured: mocks.telegramConfigured }));
vi.mock("../notify/notification-strings.js", () => ({
  getUserNotificationLanguage: vi.fn(async () => "ko"),
}));

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const auth = { authorization: `Bearer ${TOKEN}` };
const SUB_ID = "11111111-2222-4333-8444-555555555555";
const TOK_ID = "66666666-7777-4888-9999-000000000000";
const BASE = "/api/notifications/alert-endpoints";

async function buildApp(opts: { withRateLimit?: boolean } = {}) {
  const { alertEndpointRoutes } = await import("../routes/alert-endpoints.js");
  const app = Fastify();
  if (opts.withRateLimit) await app.register(rateLimit, { max: 1000, timeWindow: "1 minute" });
  await app.register(alertEndpointRoutes, { prefix: BASE });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.subFindMany.mockResolvedValue([
    {
      id: SUB_ID,
      endpoint: "https://fcm.googleapis.com/fcm/send/SECRET",
      deviceId: "this-browser",
      browser: "chrome",
      os: "android",
      createdAt: new Date("2026-11-01T00:00:00Z"),
      needsResubscribeAt: null,
    },
  ]);
  mocks.userFindUnique.mockResolvedValue({ id: "user-1", telegramChatId: null });
  mocks.telegramConfigured.mockReturnValue(true);
  mocks.tokenFindMany.mockResolvedValue([]);
  mocks.logGroupBy.mockResolvedValue([
    { subscriptionId: SUB_ID, _max: { receivedAt: new Date("2026-11-07T00:00:00Z") } },
  ]);
  mocks.presenceList.mockReturnValue([]);
});

describe("GET alert-endpoints", () => {
  it("rejects an unauthenticated caller", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: BASE })).statusCode).toBe(401);
    await app.close();
  });

  it("returns the caller's endpoints scoped by user id, without secrets", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: BASE,
      headers: { ...auth, "x-push-device": "this-browser" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.phoneConfigured).toBe(true);
    expect(body.endpoints[0]).toMatchObject({
      kind: "web",
      id: SUB_ID,
      browser: "chrome",
      os: "android",
      current: true,
      lastReceivedAt: "2026-11-07T00:00:00.000Z",
      needsResubscribe: false,
    });
    expect(res.body).not.toContain("SECRET");
    expect(res.body).not.toContain("this-browser");

    expect(mocks.subFindMany.mock.calls[0][0].where).toEqual({ userId: "user-1" });
    expect(mocks.tokenFindMany.mock.calls[0][0].where).toEqual({ userId: "user-1" });
    expect(mocks.logGroupBy.mock.calls[0][0].where).toMatchObject({
      userId: "user-1",
      subscriptionId: { in: [SUB_ID] },
    });
    expect(mocks.presenceList).toHaveBeenCalledWith("user-1", expect.any(Number));
    await app.close();
  });

  it("selects no key material from the database", async () => {
    const app = await buildApp();
    await app.inject({ method: "GET", url: BASE, headers: auth });
    const select = mocks.subFindMany.mock.calls[0][0].select;
    expect(select).not.toHaveProperty("p256dh");
    expect(select).not.toHaveProperty("auth");
    expect(mocks.tokenFindMany.mock.calls[0][0].select).not.toHaveProperty("token");
    await app.close();
  });

  it("rejects an oversized deviceId", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: BASE,
      headers: { ...auth, "x-push-device": "x".repeat(200) },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("POST web/:id/test", () => {
  it("sends one test to that subscription, in the user's language", async () => {
    mocks.sendTestPushToSubscription.mockResolvedValue({
      status: "sent",
      delivered: true,
      deliveryId: "delivery-1",
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/web/${SUB_ID}/test`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    // The delivery id lets the client watch the test arrive (GET deliveries/:id).
    expect(res.json()).toEqual({ sent: true, deliveryId: "delivery-1" });
    const [userId, subId, payload] = mocks.sendTestPushToSubscription.mock.calls[0];
    expect(userId).toBe("user-1");
    expect(subId).toBe(SUB_ID);
    expect(payload.title).toMatch(/Klorn/);
    expect(payload.title).not.toMatch(/test alert/i); // ko copy, not English
    await app.close();
  });

  it("answers 404 for a subscription that is not the caller's", async () => {
    mocks.sendTestPushToSubscription.mockResolvedValue({ status: "not_found" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/web/${SUB_ID}/test`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("reports a skipped send without pretending it went out", async () => {
    mocks.sendTestPushToSubscription.mockResolvedValue({
      status: "skipped",
      reason: "missing_vapid_keys",
      delivered: false,
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/web/${SUB_ID}/test`,
      headers: auth,
    });
    expect(res.json()).toEqual({ sent: false, reason: "missing_vapid_keys" });
    await app.close();
  });

  it("rejects a malformed id before touching the database", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/web/not-an-id;drop/test`,
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(mocks.sendTestPushToSubscription).not.toHaveBeenCalled();
    await app.close();
  });

  it("rate-limits test sends per user across web and native rows", async () => {
    mocks.sendTestPushToSubscription.mockResolvedValue({ status: "sent", delivered: true });
    mocks.tokenFindFirst.mockResolvedValue({ id: TOK_ID, platform: "android" });
    mocks.sendDevicePush.mockResolvedValue({ status: "sent", accepted: 1 });
    const app = await buildApp({ withRateLimit: true });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const url = i % 2 === 0 ? `${BASE}/web/${SUB_ID}/test` : `${BASE}/native/${TOK_ID}/test`;
      codes.push((await app.inject({ method: "POST", url, headers: auth })).statusCode);
    }
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes[5]).toBe(429);
    await app.close();
  });
});

describe("POST native/:id/test", () => {
  it("rings only that Android token", async () => {
    mocks.tokenFindFirst.mockResolvedValue({ id: TOK_ID, platform: "android" });
    mocks.sendDevicePush.mockResolvedValue({ status: "sent", accepted: 1 });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/native/${TOK_ID}/test`,
      headers: auth,
    });
    expect(res.json()).toEqual({ sent: true, deliveryId: "row-9" });
    expect(mocks.recordChannelSend).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        channel: "fcm",
        category: "system",
        outcome: { status: "sent" },
      }),
    );
    expect(mocks.tokenFindFirst.mock.calls[0][0].where).toEqual({ id: TOK_ID, userId: "user-1" });
    expect(mocks.sendDevicePush.mock.calls[0][3]).toEqual({ tokenId: TOK_ID });
    expect(mocks.sendApnsPush).not.toHaveBeenCalled();
    await app.close();
  });

  it("rings an iOS token through APNs", async () => {
    mocks.tokenFindFirst.mockResolvedValue({ id: TOK_ID, platform: "ios" });
    mocks.sendApnsPush.mockResolvedValue({ status: "skipped", reason: "missing_apns_credentials" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/native/${TOK_ID}/test`,
      headers: auth,
    });
    expect(res.json()).toEqual({ sent: false, reason: "missing_apns_credentials" });
    expect(mocks.sendApnsPush.mock.calls[0][3]).toEqual({ tokenId: TOK_ID });
    await app.close();
  });

  it("answers 404 for a token that is not the caller's", async () => {
    mocks.tokenFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/native/${TOK_ID}/test`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("DELETE", () => {
  it("removes a web subscription scoped to the caller", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: `${BASE}/web/${SUB_ID}`, headers: auth });
    expect(res.statusCode).toBe(204);
    expect(mocks.subDeleteMany.mock.calls[0][0]).toEqual({
      where: { id: SUB_ID, userId: "user-1" },
    });
    await app.close();
  });

  it("answers 404 when nothing of the caller's matched", async () => {
    mocks.tokenDeleteMany.mockResolvedValueOnce({ count: 0 });
    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: `${BASE}/native/${TOK_ID}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(mocks.tokenDeleteMany.mock.calls[0][0]).toEqual({
      where: { id: TOK_ID, userId: "user-1" },
    });
    await app.close();
  });

  it("rejects an unauthenticated delete", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: `${BASE}/web/${SUB_ID}` });
    expect(res.statusCode).toBe(401);
    expect(mocks.subDeleteMany).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("GET deliveries/:id", () => {
  const DELIVERY_ID = "99999999-8888-4777-8666-555555555555";

  it("reports the lifecycle of the caller's own delivery", async () => {
    mocks.getDeliveryStatus.mockResolvedValue({ id: DELIVERY_ID, state: "device_received" });
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `${BASE}/deliveries/${DELIVERY_ID}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: DELIVERY_ID, state: "device_received" });
    expect(mocks.getDeliveryStatus).toHaveBeenCalledWith("user-1", DELIVERY_ID);
    await app.close();
  });

  it("answers 404 for a delivery that is not the caller's", async () => {
    mocks.getDeliveryStatus.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `${BASE}/deliveries/${DELIVERY_ID}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("rejects a malformed id and an unauthenticated caller", async () => {
    const app = await buildApp();
    const bad = await app.inject({ method: "GET", url: `${BASE}/deliveries/x`, headers: auth });
    expect(bad.statusCode).toBe(400);
    const anon = await app.inject({ method: "GET", url: `${BASE}/deliveries/${DELIVERY_ID}` });
    expect(anon.statusCode).toBe(401);
    expect(mocks.getDeliveryStatus).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("GET health", () => {
  it("rejects an unauthenticated caller", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `${BASE}/health` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("reports every channel for the caller, with this browser's own state", async () => {
    mocks.subFindMany.mockResolvedValue([
      {
        id: SUB_ID,
        endpoint: "https://fcm.googleapis.com/fcm/send/SECRET",
        deviceId: "this-browser",
        browser: "chrome",
        os: "macos",
        createdAt: new Date("2026-10-01T00:00:00Z"),
        needsResubscribeAt: new Date("2026-11-10T00:00:00Z"),
      },
    ]);
    mocks.userFindUnique.mockResolvedValue({ id: "user-1", telegramChatId: "12345" });
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `${BASE}/health`,
      headers: { ...auth, "x-push-device": "this-browser" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      webPush: { state: "needs_resubscribe", currentDevice: "needs_resubscribe" },
      desktop: [],
      telegram: { linked: true },
      mobile: { registered: false },
      working: true,
    });
    expect(res.body).not.toContain("SECRET");
    expect(res.body).not.toContain("12345");
    expect(mocks.subFindMany.mock.calls[0][0].where).toEqual({ userId: "user-1" });
    expect(mocks.userFindUnique.mock.calls[0][0].where).toEqual({ id: "user-1" });
    await app.close();
  });

  it("says no channel works when nothing can reach the person", async () => {
    mocks.subFindMany.mockResolvedValue([]);
    mocks.logGroupBy.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `${BASE}/health`, headers: auth });
    expect(res.json()).toMatchObject({ webPush: { state: "none" }, working: false });
    await app.close();
  });

  it("does not count a linked Telegram chat when the server has no Telegram bot", async () => {
    mocks.subFindMany.mockResolvedValue([]);
    mocks.userFindUnique.mockResolvedValue({ id: "user-1", telegramChatId: "12345" });
    mocks.telegramConfigured.mockReturnValue(false);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `${BASE}/health`, headers: auth });
    expect(res.json()).toMatchObject({ telegram: { linked: false }, working: false });
    await app.close();
  });

  it("remembers a desktop app by its last banner receipt after the socket is gone", async () => {
    mocks.subFindMany.mockResolvedValue([]);
    const seen = new Date(Date.now() - 60 * 60 * 1000);
    mocks.logGroupBy.mockImplementation(async (args: { by: string[] }) =>
      args.by.includes("channel") ? [{ channel: "desktop_mac", _max: { updatedAt: seen } }] : [],
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `${BASE}/health`, headers: auth });
    expect(res.json()).toMatchObject({
      desktop: [{ app: "mac", running: false, lastSeenAt: seen.toISOString() }],
      working: true,
    });
    await app.close();
  });
});
