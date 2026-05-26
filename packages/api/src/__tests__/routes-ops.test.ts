import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";
import { clearFallbackState, markKeyLimited } from "../model-fallback.js";

vi.mock("../email.js", () => ({ sendVerificationEmail: vi.fn(), sendPasswordResetEmail: vi.fn() }));
vi.mock("../gmail.js", () => ({
  getAuthUrl: vi.fn(),
  getLoginAuthUrl: vi.fn(),
  getAuthedClient: vi.fn(),
  getGoogleUserInfo: vi.fn(),
  getOAuth2Client: vi.fn(),
}));
vi.mock("../briefing-status.js", () => ({
  getBriefingStatus: vi.fn(async () => ({
    generated: false,
    automation: { enabled: true, briefingTime: "09:00" },
    push: {
      state: "not_sent",
      reason: null,
      deliveryId: null,
      acceptedAt: null,
      receivedAt: null,
      clickedAt: null,
    },
  })),
}));

vi.mock("../db.js", () => {
  const now = new Date("2026-04-29T08:00:00.000Z");
  const prisma = {
    $queryRaw: vi.fn(async () => [{ "?column?": 1 }]),
    device: {
      count: vi.fn(async () => 2),
      findUnique: vi.fn(async () => ({ id: "device-1" })),
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
    },
    pushSubscription: {
      count: vi.fn(async () => 2),
      findMany: vi.fn(async () => []),
    },
    pushDeliveryLog: {
      findMany: vi.fn(async () => [
        {
          status: "ACCEPTED",
          receivedAt: now,
          clickedAt: null,
        },
      ]),
    },
    userToken: {
      findUnique: vi.fn(async () => ({
        provider: "google",
        refreshToken: "refresh",
        gmailWatchExpiresAt: new Date("2026-05-05T00:00:00.000Z"),
      })),
    },
    automationConfig: {
      findUnique: vi.fn(async () => ({
        dailyBriefing: true,
        briefingTime: "09:00",
        reminderAutoCheck: true,
        emailAutoClassify: true,
        autonomousAgent: true,
        agentMode: "SUGGEST",
      })),
    },
    reminder: {
      count: vi.fn(async ({ where }: { where: { remindAt?: { lte: Date } } }) =>
        where.remindAt ? 0 : 1,
      ),
      findFirst: vi.fn(async () => ({
        id: "rem-1",
        title: "Test reminder",
        remindAt: new Date("2026-04-29T08:30:00.000Z"),
      })),
    },
    notification: {
      findMany: vi.fn(async () => [{ id: "notif-1", title: "Reminder", createdAt: now }]),
    },
    emailMessage: { count: vi.fn(async () => 3) },
    calendarEvent: { count: vi.fn(async () => 1) },
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })) },
  };
  return { prisma, db: prisma };
});

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

async function buildApp() {
  const { opsRoutes } = await import("../routes/ops.js");
  const app = Fastify();
  await app.register(opsRoutes, { prefix: "/api/ops" });
  return app;
}

describe("ops routes", () => {
  afterEach(() => {
    clearFallbackState();
  });

  it("rejects unauthenticated readiness requests", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/ops/readiness" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns deployment and user readiness checks", async () => {
    process.env.VAPID_PUBLIC_KEY = "public";
    process.env.VAPID_PRIVATE_KEY = "private";
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/ops/readiness",
      headers: auth(),
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    const keys = body.checks.map((check: { key: string }) => check.key);
    expect(keys).toContain("push");
    expect(keys).toContain("aiProvider");
    expect(body.checks.find((check: { key: string }) => check.key === "push").detail).toMatchObject(
      { subscriptions: 2, received: 1 },
    );
    const ai = body.checks.find((check: { key: string }) => check.key === "aiProvider");
    expect(ai.status).toBe("ok");
    expect(ai.detail.unavailableCount).toBe(0);
    expect(body.system).toHaveProperty("uptime");
    await app.close();
  });

  it("downgrades overall status to error when every AI provider is in cooldown", async () => {
    process.env.VAPID_PUBLIC_KEY = "public";
    process.env.VAPID_PRIVATE_KEY = "private";
    markKeyLimited("openrouter:env");
    markKeyLimited("gemini:env");
    markKeyLimited("openrouter:user:user-1");
    markKeyLimited("gemini:user:user-1");

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/ops/readiness",
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ai = body.checks.find((check: { key: string }) => check.key === "aiProvider");
    expect(ai.status).toBe("error");
    expect(ai.detail.unavailableCount).toBe(4);
    expect(ai.message).toMatch(/cooldown/i);
    expect(body.status).toBe("error");
    await app.close();
  });
});
