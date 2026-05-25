import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

// Set before importing push-origin-allowlist (loaded transitively via routes).
process.env.PUSH_ALLOWED_ORIGINS = "https://app.klorn.ai,http://localhost:8001";

vi.mock("../email.js", () => ({ sendVerificationEmail: vi.fn(), sendPasswordResetEmail: vi.fn() }));
vi.mock("../gmail.js", () => ({
  getAuthUrl: vi.fn(),
  getLoginAuthUrl: vi.fn(),
  getAuthedClient: vi.fn(),
  getGoogleUserInfo: vi.fn(),
  getOAuth2Client: vi.fn(),
}));
vi.mock("../background.js", () => ({
  getNotifications: vi.fn(async () => [
    { id: "n1", type: "info", title: "Test", message: "msg", isRead: false },
  ]),
  markNotificationRead: vi.fn(async () => {}),
  markAllNotificationsRead: vi.fn(async () => {}),
  clearNotifications: vi.fn(async () => {}),
}));
vi.mock("../push.js", () => ({
  getVapidPublicKey: vi.fn(() => "test-vapid-key"),
  sendPushNotification: vi.fn(async () => ({
    status: "sent",
    subscriptions: 1,
    attempted: 1,
    accepted: 1,
    failed: 0,
  })),
}));
vi.mock("../push-delivery.js", () => ({
  recordPushReceipt: vi.fn(async () => true),
  getPushDeliveryStats: vi.fn(async () => ({
    since: "2026-04-28T00:00:00.000Z",
    total: 1,
    accepted: 1,
    failed: 0,
    skipped: 0,
    received: 1,
    clicked: 0,
    receiptRate: 1,
    clickRate: 0,
    recent: [],
  })),
}));

vi.mock("../db.js", () => {
  const prisma = {
    notification: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === "n1") return { id: "n1", userId: "user-1", isRead: false };
        return null;
      }),
    },
    pushSubscription: {
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({})),
    },
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
const OTHER = signToken({ userId: "user-2", email: "o@e.com" });
const auth = (t = TOKEN) => ({ authorization: `Bearer ${t}` });

async function buildApp() {
  const { notificationRoutes } = await import("../routes/notifications.js");
  const app = Fastify();
  await app.register(notificationRoutes, { prefix: "/api/notifications" });
  return app;
}

describe("notification routes", () => {
  it("rejects unauthenticated with 401", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/api/notifications" })).statusCode).toBe(401);
    await app.close();
  });

  it("lists notifications", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/notifications", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().notifications).toHaveLength(1);
    expect(res.json()).toHaveProperty("unread");
    await app.close();
  });

  it("marks notification as read", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/notifications/n1/read",
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("returns 403 for other user's notification", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/notifications/n1/read",
      headers: auth(OTHER),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("marks all as read", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/notifications/read-all",
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("clears all notifications", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/notifications", headers: auth() });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("returns VAPID public key", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/notifications/vapid-key",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().publicKey).toBe("test-vapid-key");
    await app.close();
  });

  it("records push receipts without auth", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/receipts/delivery-1",
      payload: { event: "received" },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("rejects invalid push receipt events", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/receipts/delivery-1",
      payload: { event: "opened" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("registers push subscription with valid HTTPS endpoint and allowed origin", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/subscribe",
      headers: auth(),
      payload: {
        endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
        keys: { p256dh: "key1", auth: "key2" },
        origin: "https://app.klorn.ai",
      },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it("rejects push subscribe from a non-allowlisted origin", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/subscribe",
      headers: auth(),
      payload: {
        endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
        keys: { p256dh: "k1", auth: "k2" },
        origin: "https://hire-eve-web.vercel.app",
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects push subscribe with HTTP endpoint", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/subscribe",
      headers: auth(),
      payload: {
        endpoint: "http://insecure.example.com/push",
        keys: { p256dh: "k1", auth: "k2" },
        origin: "https://app.klorn.ai",
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects push subscribe with localhost (SSRF)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/subscribe",
      headers: auth(),
      payload: {
        endpoint: "https://localhost:3000/push",
        keys: { p256dh: "k1", auth: "k2" },
        origin: "https://app.klorn.ai",
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("unsubscribes push", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/notifications/push/unsubscribe",
      headers: auth(),
      payload: { endpoint: "https://fcm.googleapis.com/fcm/send/abc" },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("returns push delivery stats", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/notifications/push/delivery-stats?hours=24&limit=10",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 1, received: 1, receiptRate: 1 });
    await app.close();
  });
});
