import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("../notify/push.js", () => ({ sendPushNotification: vi.fn(async () => {}) }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../stripe.js", () => ({
  stripe: {
    webhooks: {
      constructEvent: vi.fn((_body: string, sig: string, _secret: string) => {
        if (sig === "invalid") throw new Error("Invalid signature");
        return {
          id: "evt_test",
          type: "checkout.session.completed",
          data: {
            object: {
              metadata: { userId: "user-1", plan: "PRO" },
              customer: "cus_test",
            },
          },
        };
      }),
    },
  },
}));

vi.mock("../db.js", () => {
  const prisma = {
    user: {
      update: vi.fn(async () => ({})),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({})),
    },
    notification: { create: vi.fn(async () => ({ id: "n1", createdAt: new Date() })) },
    webhookEvent: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});

async function buildApp() {
  const { webhookRoutes } = await import("../routes/webhook.js");
  const app = Fastify();
  await app.register(webhookRoutes, { prefix: "/api/webhook" });
  return app;
}

describe("webhook routes", () => {
  it("returns 500 when webhook secret not configured", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhook/stripe",
      headers: { "stripe-signature": "valid", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.statusCode).toBe(500);
    await app.close();
  });

  it("returns 400 for invalid signature", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhook/stripe",
      headers: { "stripe-signature": "invalid", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.statusCode).toBe(400);
    delete process.env.STRIPE_WEBHOOK_SECRET;
    await app.close();
  });

  it("processes valid webhook event", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhook/stripe",
      headers: { "stripe-signature": "valid", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().received).toBe(true);
    delete process.env.STRIPE_WEBHOOK_SECRET;
    await app.close();
  });

  it("skips an event already recorded in WebhookEvent (idempotent dedup)", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.user.update).mockClear();
    vi.mocked(prisma.webhookEvent.create).mockClear();
    // The event id is already persisted → handler must skip processing.
    vi.mocked(prisma.webhookEvent.findUnique).mockResolvedValueOnce({
      id: "evt_test",
      processedAt: new Date(),
    } as never);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhook/stripe",
      headers: { "stripe-signature": "valid", "content-type": "application/json" },
      body: "{}",
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.user.update).not.toHaveBeenCalled(); // processing skipped
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled(); // not re-recorded
    delete process.env.STRIPE_WEBHOOK_SECRET;
    await app.close();
  });

  // ── RevenueCat (in-app purchase) webhook ──────────────────────────────────
  const RC_UUID = "11111111-1111-4111-8111-111111111111";
  const rcEvent = (type: string, appUserId = RC_UUID) => ({
    event: { id: `rc_${type}_${appUserId}`, type, app_user_id: appUserId },
  });

  it("rejects a RevenueCat event whose app_user_id is not a uuid (400)", async () => {
    process.env.REVENUECAT_WEBHOOK_AUTH = "rc-secret";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhook/revenuecat",
      headers: { authorization: "rc-secret", "content-type": "application/json" },
      payload: rcEvent("INITIAL_PURCHASE", "$RCAnonymousID:abc"),
    });
    expect(res.statusCode).toBe(400);
    delete process.env.REVENUECAT_WEBHOOK_AUTH;
    await app.close();
  });

  it("notifies but does not revoke on BILLING_ISSUE (grace period)", async () => {
    process.env.REVENUECAT_WEBHOOK_AUTH = "rc-secret";
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.user.update).mockClear();
    vi.mocked(prisma.notification.create).mockClear();
    vi.mocked(prisma.webhookEvent.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: RC_UUID,
      plan: "PRO",
    } as never);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhook/revenuecat",
      headers: { authorization: "rc-secret", "content-type": "application/json" },
      payload: rcEvent("BILLING_ISSUE"),
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.notification.create).toHaveBeenCalled();
    delete process.env.REVENUECAT_WEBHOOK_AUTH;
    await app.close();
  });

  it("rejects a RevenueCat webhook with a wrong/missing Authorization header (401)", async () => {
    process.env.REVENUECAT_WEBHOOK_AUTH = "rc-secret";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhook/revenuecat",
      headers: { authorization: "wrong", "content-type": "application/json" },
      payload: rcEvent("INITIAL_PURCHASE"),
    });
    expect(res.statusCode).toBe(401);
    delete process.env.REVENUECAT_WEBHOOK_AUTH;
    await app.close();
  });

  it("grants PRO on a RevenueCat INITIAL_PURCHASE for a FREE user", async () => {
    process.env.REVENUECAT_WEBHOOK_AUTH = "rc-secret";
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.user.update).mockClear();
    vi.mocked(prisma.webhookEvent.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: "user-1",
      plan: "FREE",
    } as never);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhook/revenuecat",
      headers: { authorization: "rc-secret", "content-type": "application/json" },
      payload: rcEvent("INITIAL_PURCHASE"),
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { plan: "PRO" } }),
    );
    delete process.env.REVENUECAT_WEBHOOK_AUTH;
    await app.close();
  });

  it("revokes to FREE on a RevenueCat EXPIRATION for a PRO user", async () => {
    process.env.REVENUECAT_WEBHOOK_AUTH = "rc-secret";
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.user.update).mockClear();
    vi.mocked(prisma.webhookEvent.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: "user-1",
      plan: "PRO",
    } as never);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhook/revenuecat",
      headers: { authorization: "rc-secret", "content-type": "application/json" },
      payload: rcEvent("EXPIRATION"),
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { plan: "FREE" } }),
    );
    delete process.env.REVENUECAT_WEBHOOK_AUTH;
    await app.close();
  });

  it("does not revoke on CANCELLATION (access continues until EXPIRATION)", async () => {
    process.env.REVENUECAT_WEBHOOK_AUTH = "rc-secret";
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.user.update).mockClear();
    vi.mocked(prisma.webhookEvent.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: "user-1",
      plan: "PRO",
    } as never);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhook/revenuecat",
      headers: { authorization: "rc-secret", "content-type": "application/json" },
      payload: rcEvent("CANCELLATION"),
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.user.update).not.toHaveBeenCalled();
    delete process.env.REVENUECAT_WEBHOOK_AUTH;
    await app.close();
  });
});
