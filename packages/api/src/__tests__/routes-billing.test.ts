import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

vi.mock("../email.js", () => ({ sendVerificationEmail: vi.fn(), sendPasswordResetEmail: vi.fn() }));
vi.mock("../gmail.js", () => ({
  getAuthUrl: vi.fn(),
  getLoginAuthUrl: vi.fn(),
  getAuthedClient: vi.fn(),
  getGoogleUserInfo: vi.fn(),
  getOAuth2Client: vi.fn(),
  GMAIL_TOOLS: [],
}));

vi.mock("../stripe.js", () => ({
  stripe: {
    checkout: {
      sessions: { create: vi.fn(async () => ({ url: "https://checkout.stripe.com/test" })) },
    },
    billingPortal: {
      sessions: { create: vi.fn(async () => ({ url: "https://billing.stripe.com/test" })) },
    },
  },
  getEffectivePlan: vi.fn(() => ({
    name: "FREE",
    messageLimit: 50,
    tokenLimit: 100000,
    deviceLimit: 3,
  })),
  PLANS: { PRO: { priceId: "price_pro" }, TEAM: { priceId: "price_team" } },
  PLAN_FEATURES: { FREE: new Set(["basic"]) },
}));

vi.mock("../db.js", () => {
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({
        id: "user-1",
        email: "t@e.com",
        plan: "FREE",
        role: "USER",
        stripeId: null,
      })),
    },
    message: { count: vi.fn(async () => 10) },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  const db = {
    ...prisma,
    tokenUsage: {
      aggregate: vi.fn(async () => ({ _sum: { totalTokens: 500, estimatedCost: 0.01 } })),
    },
  };
  return { prisma, db };
});

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

async function buildApp() {
  const { billingRoutes } = await import("../routes/billing.js");
  const app = Fastify();
  await app.register(billingRoutes, { prefix: "/api/billing" });
  return app;
}

describe("billing routes", () => {
  it("rejects unauthenticated with 401", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/api/billing/status" })).statusCode).toBe(401);
    await app.close();
  });

  it("returns billing status", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/billing/status", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("plan");
    expect(res.json()).toHaveProperty("messageLimit");
    expect(res.json()).toHaveProperty("tokenUsage");
    await app.close();
  });

  it("returns plan features", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/billing/features", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("plan");
    expect(res.json()).toHaveProperty("features");
    await app.close();
  });

  it("returns active model and BYOK key status", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/billing/models", headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("activeModel");
    expect(body).toHaveProperty("hasOpenRouterApiKey");
    expect(body).toHaveProperty("hasGeminiApiKey");
    expect(body).not.toHaveProperty("chatModels");
    expect(body).not.toHaveProperty("agentModels");
    await app.close();
  });

  it("creates checkout session", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/billing/checkout",
      headers: auth(),
      payload: { plan: "PRO" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toContain("stripe.com");
    await app.close();
  });

  it("rejects invalid plan", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/billing/checkout",
      headers: auth(),
      payload: { plan: "INVALID" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
