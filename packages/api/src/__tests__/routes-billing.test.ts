import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

vi.mock("../mail/email.js", () => ({
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));
vi.mock("../mail/gmail.js", () => ({
  getAuthUrl: vi.fn(),
  getLoginAuthUrl: vi.fn(),
  getAuthedClient: vi.fn(),
  getGoogleUserInfo: vi.fn(),
  getOAuth2Client: vi.fn(),
  GMAIL_TOOLS: [],
}));

vi.mock("../billing/verify-provider-key.js", () => ({
  // Default "valid" so key-set tests pass; individual tests override per call.
  verifyOpenRouterKey: vi.fn(async () => "valid"),
}));

vi.mock("../billing/stripe.js", () => ({
  stripe: {
    checkout: {
      sessions: { create: vi.fn(async () => ({ url: "https://checkout.stripe.com/test" })) },
    },
    billingPortal: {
      sessions: { create: vi.fn(async () => ({ url: "https://billing.stripe.com/test" })) },
    },
    customers: { list: vi.fn(async () => ({ data: [] })) },
  },
  getEffectivePlan: vi.fn(() => ({
    name: "FREE",
    messageLimit: 50,
    tokenLimit: 100000,
    deviceLimit: 3,
  })),
  PLANS: { PRO: { priceId: "price_pro" }, TEAM: { priceId: "price_team" } },
  PLAN_FEATURES: { FREE: new Set(["basic"]) },
  isEntitled: vi.fn(() => true),
  isWebCheckoutAvailable: vi.fn(() => true),
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
        chatModel: "google/gemini-2.5-flash",
      })),
      update: vi.fn(async () => ({})),
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
    // Drives the web paywall's disabled state when Stripe is unconfigured.
    expect(res.json()).toHaveProperty("webCheckoutAvailable", true);
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

  it("GET /models lists the frontier catalog and selectedModel from user", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/billing/models", headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.availableModels)).toBe(true);
    expect(body.availableModels.map((m: { id: string }) => m.id)).toContain(
      "anthropic/claude-sonnet-5",
    );
    // Default mock user's stored model is a legacy id → treated as unset.
    expect(body.selectedModel).toBeNull();
    await app.close();
  });

  it("PATCH /models with a curated chatModel persists it", async () => {
    const { prisma } = await import("../db.js");
    const findMock = prisma.user.findUnique as ReturnType<typeof vi.fn>;
    // requireAuth → sessionRevokedForToken calls findUnique first (select: sessionsInvalidatedAt).
    // The billing handler then calls findUnique again for the full user record.
    // Queue two one-time responses so each call gets the right shape.
    findMock.mockResolvedValueOnce({ sessionsInvalidatedAt: null }); // auth call
    findMock.mockResolvedValueOnce({
      id: "user-1",
      email: "t@e.com",
      plan: "FREE",
      role: "USER",
      stripeId: null,
      chatModel: "google/gemini-2.5-flash",
      openRouterApiKey: "enc:sk-or-v1-xxx",
      geminiApiKey: null,
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/billing/models",
      headers: auth(),
      payload: { chatModel: "anthropic/claude-sonnet-5" },
    });
    expect(res.statusCode).toBe(200);
    expect(
      (prisma.user.update as ReturnType<typeof vi.fn>).mock.calls.some(
        (call) => call[0]?.data?.chatModel === "anthropic/claude-sonnet-5",
      ),
    ).toBe(true);
    await app.close();
  });

  it("PATCH /models with an unknown chatModel returns 400 and does not persist", async () => {
    const { prisma } = await import("../db.js");
    const updateMock = prisma.user.update as ReturnType<typeof vi.fn>;
    updateMock.mockClear();
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/billing/models",
      headers: auth(),
      payload: { chatModel: "some/unknown-model" },
    });
    expect(res.statusCode).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("PATCH /models chatModel WITHOUT any provider key persists (choice is for everyone)", async () => {
    const { prisma } = await import("../db.js");
    const updateMock = prisma.user.update as ReturnType<typeof vi.fn>;
    updateMock.mockClear();
    // Default mock user has no keys (openRouterApiKey/geminiApiKey absent = falsy)
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/billing/models",
      headers: auth(),
      payload: { chatModel: "anthropic/claude-sonnet-5" },
    });
    expect(res.statusCode).toBe(200);
    expect(
      updateMock.mock.calls.some(
        (call) => call[0]?.data?.chatModel === "anthropic/claude-sonnet-5",
      ),
    ).toBe(true);
    await app.close();
  });

  it("GET /models returns selectedModel: null for a non-curated chatModel", async () => {
    const { prisma } = await import("../db.js");
    const findMock = prisma.user.findUnique as ReturnType<typeof vi.fn>;
    // requireAuth → sessionRevokedForToken calls findUnique first; billing GET handler second.
    findMock.mockResolvedValueOnce({ sessionsInvalidatedAt: null }); // auth call
    findMock.mockResolvedValueOnce({
      id: "user-1",
      email: "t@e.com",
      plan: "FREE",
      role: "USER",
      stripeId: null,
      chatModel: "google/gemma-4-31b-it:free",
      openRouterApiKey: null,
      geminiApiKey: null,
    });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/billing/models", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().selectedModel).toBeNull();
    await app.close();
  });
  it("PATCH /models rejects a NEW geminiApiKey — single-key policy (#today's outage)", async () => {
    const { prisma } = await import("../db.js");
    const updateMock = prisma.user.update as ReturnType<typeof vi.fn>;
    updateMock.mockClear();
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/billing/models",
      headers: auth(),
      payload: { geminiApiKey: "AIza-legacy-key" },
    });
    expect(res.statusCode).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("clearGeminiApiKey still clears the legacy slot", async () => {
    const { prisma } = await import("../db.js");
    const updateMock = prisma.user.update as ReturnType<typeof vi.fn>;
    updateMock.mockClear();
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/billing/models",
      headers: auth(),
      payload: { clearGeminiApiKey: true },
    });
    expect(res.statusCode).toBe(200);
    expect(updateMock.mock.calls.some((call) => call[0]?.data?.geminiApiKey === null)).toBe(true);
    await app.close();
  });

  it("a dead OpenRouter key is rejected upstream-verified, never stored silently", async () => {
    const { verifyOpenRouterKey } = await import("../billing/verify-provider-key.js");
    (verifyOpenRouterKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce("invalid");
    const { prisma } = await import("../db.js");
    const findMock = prisma.user.findUnique as ReturnType<typeof vi.fn>;
    findMock.mockResolvedValueOnce({ sessionsInvalidatedAt: null });
    findMock.mockResolvedValueOnce({
      id: "user-1",
      email: "t@e.com",
      plan: "PRO",
      role: "USER",
      stripeId: null,
      chatModel: null,
      openRouterApiKey: null,
      geminiApiKey: null,
    });
    const updateMock = prisma.user.update as ReturnType<typeof vi.fn>;
    updateMock.mockClear();
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/billing/models",
      headers: auth(),
      payload: { openRouterApiKey: "sk-or-v1-dead" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/rejected|invalid/i);
    expect(updateMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("provider unreachable → fail-open: the key stores (never block a save on provider noise)", async () => {
    const { verifyOpenRouterKey } = await import("../billing/verify-provider-key.js");
    (verifyOpenRouterKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce("unreachable");
    const { prisma } = await import("../db.js");
    const findMock = prisma.user.findUnique as ReturnType<typeof vi.fn>;
    findMock.mockResolvedValueOnce({ sessionsInvalidatedAt: null });
    findMock.mockResolvedValueOnce({
      id: "user-1",
      email: "t@e.com",
      plan: "PRO",
      role: "USER",
      stripeId: null,
      chatModel: null,
      openRouterApiKey: null,
      geminiApiKey: null,
    });
    const updateMock = prisma.user.update as ReturnType<typeof vi.fn>;
    updateMock.mockClear();
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/billing/models",
      headers: auth(),
      payload: { openRouterApiKey: "sk-or-v1-fine" },
    });
    expect(res.statusCode).toBe(200);
    expect(
      updateMock.mock.calls.some((call) => typeof call[0]?.data?.openRouterApiKey === "string"),
    ).toBe(true);
    await app.close();
  });
});
