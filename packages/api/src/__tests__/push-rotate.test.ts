/**
 * POST /api/notifications/push/rotate — subscription swap from the SW's
 * pushsubscriptionchange handler. No bearer auth: the OLD endpoint (an
 * unguessable capability URL) must match an existing row, and rows are only
 * ever updated in place — never created.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const subFindUnique = vi.hoisted(() => vi.fn());
const subDeleteMany = vi.hoisted(() => vi.fn(async () => ({ count: 0 })));
const subUpdate = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("../db.js", () => {
  const prisma = {
    pushSubscription: {
      findUnique: subFindUnique,
      deleteMany: subDeleteMany,
      update: subUpdate,
    },
  };
  return { prisma, db: prisma };
});

vi.mock("../background.js", () => ({
  clearNotifications: vi.fn(),
  getNotifications: vi.fn(async () => []),
  markAllNotificationsRead: vi.fn(),
  markNotificationRead: vi.fn(),
}));

vi.mock("../notify/push.js", () => ({
  getVapidPublicKey: vi.fn(() => null),
  sendPushNotification: vi.fn(),
}));

vi.mock("../notify/push-delivery.js", () => ({
  getPushDeliveryStats: vi.fn(async () => ({})),
  recordPushReceipt: vi.fn(),
}));

const GOOD_ENDPOINT = "https://fcm.googleapis.com/fcm/send/new-endpoint-abc";
const OLD_ENDPOINT = "https://fcm.googleapis.com/fcm/send/old-endpoint-xyz";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    oldEndpoint: OLD_ENDPOINT,
    endpoint: GOOD_ENDPOINT,
    keys: { p256dh: "p256dh-new", auth: "auth-new" },
    ...overrides,
  };
}

async function buildApp() {
  const { notificationRoutes } = await import("../routes/notifications.js");
  const app = Fastify();
  await app.register(notificationRoutes, { prefix: "/api/notifications" });
  return app;
}

describe("POST /api/notifications/push/rotate", () => {
  beforeEach(() => {
    subFindUnique.mockReset();
    subDeleteMany.mockClear();
    subUpdate.mockClear();
  });

  it("rejects an incomplete payload", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/rotate",
      payload: payload({ keys: { p256dh: "x" } }),
    });
    expect(res.statusCode).toBe(400);
    expect(subUpdate).not.toHaveBeenCalled();
  });

  it("rejects an invalid new endpoint (SSRF guard shared with subscribe)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/rotate",
      payload: payload({ endpoint: "https://169.254.169.254/latest/meta-data" }),
    });
    expect(res.statusCode).toBe(400);
    expect(subUpdate).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown old endpoint and never creates a row", async () => {
    subFindUnique.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/rotate",
      payload: payload(),
    });
    expect(res.statusCode).toBe(404);
    expect(subUpdate).not.toHaveBeenCalled();
    expect(subDeleteMany).not.toHaveBeenCalled();
  });

  it("swaps endpoint + keys in place, preserving the row (and its userId)", async () => {
    subFindUnique.mockResolvedValue({ id: "sub-1", userId: "user-1" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/rotate",
      payload: payload(),
    });
    expect(res.statusCode).toBe(204);
    // Stale duplicates of the NEW endpoint are cleared before the swap.
    expect(subDeleteMany).toHaveBeenCalledWith({
      where: { endpoint: GOOD_ENDPOINT, id: { not: "sub-1" } },
    });
    expect(subUpdate).toHaveBeenCalledWith({
      where: { id: "sub-1" },
      data: { endpoint: GOOD_ENDPOINT, p256dh: "p256dh-new", auth: "auth-new" },
    });
  });

  it("works without any Authorization header (SW context)", async () => {
    subFindUnique.mockResolvedValue({ id: "sub-1", userId: "user-1" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/rotate",
      headers: {},
      payload: payload(),
    });
    expect(res.statusCode).toBe(204);
  });
});
