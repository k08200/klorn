import crypto from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../push.js", () => ({ sendPushNotification: vi.fn(async () => {}) }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));

let processedEvent: { id: string } | null = null;
const userUpdates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
let userById: Record<string, unknown> | null = {
  id: "11111111-1111-4111-8111-111111111111",
  plan: "FREE",
};
let userByCustomer: Record<string, unknown> | null = null;
const notifications: Array<{ title: string }> = [];

vi.mock("../db.js", () => {
  const prisma = {
    user: {
      findUnique: vi.fn(async () => userById),
      findFirst: vi.fn(async () => userByCustomer),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        userUpdates.push(args);
        return {};
      }),
    },
    notification: {
      create: vi.fn(async (args: { data: { title: string } }) => {
        notifications.push({ title: args.data.title });
        return { id: "n1", createdAt: new Date() };
      }),
    },
    webhookEvent: {
      findUnique: vi.fn(async () => processedEvent),
      create: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});

const SECRET = "pdl_ntfset_test";
const USER_ID = "11111111-1111-4111-8111-111111111111";

function sign(rawBody: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const h1 = crypto.createHmac("sha256", SECRET).update(`${ts}:${rawBody}`).digest("hex");
  return `ts=${ts};h1=${h1}`;
}

async function buildApp() {
  const { webhookRoutes } = await import("../routes/webhook.js");
  const app = Fastify();
  // Mirror index.ts: capture the raw body so signature verification sees the
  // exact bytes Paddle signed.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error);
    }
  });
  await app.register(webhookRoutes, { prefix: "/api/webhook" });
  return app;
}

function subscriptionEvent(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    event_id: "evt_paddle_1",
    event_type: "subscription.activated",
    data: {
      id: "sub_1",
      status: "active",
      customer_id: "ctm_1",
      custom_data: { userId: USER_ID },
      ...overrides,
    },
  });
}

async function post(app: Awaited<ReturnType<typeof buildApp>>, body: string, sig?: string) {
  return app.inject({
    method: "POST",
    url: "/api/webhook/paddle",
    headers: { "content-type": "application/json", "paddle-signature": sig ?? sign(body) },
    body,
  });
}

afterEach(() => {
  processedEvent = null;
  userUpdates.length = 0;
  notifications.length = 0;
  userById = { id: USER_ID, plan: "FREE" };
  userByCustomer = null;
  delete process.env.PADDLE_WEBHOOK_SECRET;
});

describe("POST /api/webhook/paddle", () => {
  it("returns 500 when the webhook secret is not configured", async () => {
    const app = await buildApp();
    const body = subscriptionEvent();
    const res = await post(app, body);
    expect(res.statusCode).toBe(500);
    await app.close();
  });

  it("rejects an invalid signature with 401 and grants nothing", async () => {
    process.env.PADDLE_WEBHOOK_SECRET = SECRET;
    const app = await buildApp();
    const body = subscriptionEvent();
    const res = await post(app, body, "ts=1;h1=deadbeef");
    expect(res.statusCode).toBe(401);
    expect(userUpdates).toHaveLength(0);
    await app.close();
  });

  it("grants PRO and stores the Paddle customer id on an active subscription", async () => {
    process.env.PADDLE_WEBHOOK_SECRET = SECRET;
    const app = await buildApp();
    const res = await post(app, subscriptionEvent());
    expect(res.statusCode).toBe(200);
    expect(userUpdates).toHaveLength(1);
    expect(userUpdates[0].data).toMatchObject({ plan: "PRO", paddleCustomerId: "ctm_1" });
    await app.close();
  });

  it("grants PRO for a trialing subscription (card-required trial)", async () => {
    process.env.PADDLE_WEBHOOK_SECRET = SECRET;
    const app = await buildApp();
    const res = await post(app, subscriptionEvent({ status: "trialing" }));
    expect(res.statusCode).toBe(200);
    expect(userUpdates[0]?.data).toMatchObject({ plan: "PRO" });
    await app.close();
  });

  it("revokes to FREE and notifies on a canceled subscription", async () => {
    process.env.PADDLE_WEBHOOK_SECRET = SECRET;
    userById = { id: USER_ID, plan: "PRO" };
    const app = await buildApp();
    const res = await post(
      app,
      JSON.stringify({
        event_id: "evt_paddle_2",
        event_type: "subscription.canceled",
        data: {
          id: "sub_1",
          status: "canceled",
          customer_id: "ctm_1",
          custom_data: { userId: USER_ID },
        },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(userUpdates[0]?.data).toMatchObject({ plan: "FREE" });
    expect(notifications.some((n) => /cancel/i.test(n.title))).toBe(true);
    await app.close();
  });

  it("revokes on past_due and sends a payment-issue notification (mirrors Stripe)", async () => {
    process.env.PADDLE_WEBHOOK_SECRET = SECRET;
    userById = { id: USER_ID, plan: "PRO" };
    const app = await buildApp();
    const res = await post(
      app,
      JSON.stringify({
        event_id: "evt_paddle_3",
        event_type: "subscription.updated",
        data: {
          id: "sub_1",
          status: "past_due",
          customer_id: "ctm_1",
          custom_data: { userId: USER_ID },
        },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(userUpdates[0]?.data).toMatchObject({ plan: "FREE" });
    expect(notifications.some((n) => /payment/i.test(n.title))).toBe(true);
    await app.close();
  });

  it("falls back to the stored paddleCustomerId when custom_data is missing", async () => {
    process.env.PADDLE_WEBHOOK_SECRET = SECRET;
    userById = null;
    userByCustomer = { id: USER_ID, plan: "FREE" };
    const app = await buildApp();
    const res = await post(app, subscriptionEvent({ custom_data: null }));
    expect(res.statusCode).toBe(200);
    expect(userUpdates[0]?.data).toMatchObject({ plan: "PRO" });
    await app.close();
  });

  it("acknowledges an unmapped subscription event without granting anything", async () => {
    process.env.PADDLE_WEBHOOK_SECRET = SECRET;
    userById = null;
    userByCustomer = null;
    const app = await buildApp();
    const res = await post(app, subscriptionEvent());
    // 200 (Paddle should not retry — the event is surfaced via captureError
    // for a human instead), and no plan was touched.
    expect(res.statusCode).toBe(200);
    expect(userUpdates).toHaveLength(0);
    await app.close();
  });

  it("skips an already-processed event (idempotency via WebhookEvent)", async () => {
    process.env.PADDLE_WEBHOOK_SECRET = SECRET;
    processedEvent = { id: "evt_paddle_1" };
    const app = await buildApp();
    const res = await post(app, subscriptionEvent());
    expect(res.statusCode).toBe(200);
    expect(userUpdates).toHaveLength(0);
    await app.close();
  });

  it("rejects a malformed event body with 400", async () => {
    process.env.PADDLE_WEBHOOK_SECRET = SECRET;
    const app = await buildApp();
    const body = JSON.stringify({ event_type: "subscription.activated" });
    const res = await post(app, body);
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("acknowledges unhandled event types without touching plans", async () => {
    process.env.PADDLE_WEBHOOK_SECRET = SECRET;
    const app = await buildApp();
    const body = JSON.stringify({
      event_id: "evt_paddle_4",
      event_type: "product.updated",
      data: { id: "pro_1" },
    });
    const res = await post(app, body);
    expect(res.statusCode).toBe(200);
    expect(userUpdates).toHaveLength(0);
    await app.close();
  });
});
