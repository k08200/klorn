import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("../push.js", () => ({ sendPushNotification: vi.fn() }));
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
});
