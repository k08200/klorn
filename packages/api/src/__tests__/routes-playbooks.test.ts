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
}));
vi.mock("../db.js", () => ({
  db: {
    device: {
      // A valid session has a registered device (every login registers one),
      // so the auth device lookup must resolve for requireAuth to pass.
      findUnique: vi.fn(async () => ({ id: "auth-device", userId: "user-1" })),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  },
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })),
    },
  },
}));

vi.mock("../agentcore/playbooks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agentcore/playbooks.js")>();
  return {
    ...actual,
    buildPlaybookRecommendations: vi.fn(async () => ({
      generatedAt: "2026-04-28T00:00:00.000Z",
      playbooks: actual.listKlornPlaybooks(),
      recommendations: [
        {
          playbook: actual.listKlornPlaybooks()[0],
          score: 42,
          confidence: 0.75,
          reasons: ["High-risk matching context"],
          activeContexts: [],
          suggestedFirstActions: [],
        },
      ],
    })),
  };
});

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });

async function buildApp() {
  const { playbookRoutes } = await import("../routes/playbooks.js");
  const app = Fastify();
  await app.register(playbookRoutes, { prefix: "/api/playbooks" });
  return app;
}

describe("playbook routes", () => {
  it("rejects unauthenticated requests", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/playbooks" });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("lists built-in playbooks", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/playbooks",
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().playbooks).toHaveLength(4);
    await app.close();
  });

  it("returns playbook recommendations", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/playbooks/recommendations?limit=2&contextLimit=12",
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      recommendations: [{ playbook: { id: "investment_ops" }, score: 42 }],
    });
    await app.close();
  });
});
