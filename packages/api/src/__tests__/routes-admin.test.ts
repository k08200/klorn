import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const sendBetaInviteEmailSpy = vi.fn(async () => true);
vi.mock("../email.js", () => ({
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  sendBetaInviteEmail: (...args: unknown[]) => sendBetaInviteEmailSpy(...args),
}));

type StoredWaitlist = {
  id: string;
  email: string;
  name: string | null;
  status: string;
  approvedAt: Date | null;
};
const waitlistById = new Map<string, StoredWaitlist>();
vi.mock("../gmail.js", () => ({
  getAuthUrl: vi.fn(),
  getLoginAuthUrl: vi.fn(),
  getAuthedClient: vi.fn(),
  getGoogleUserInfo: vi.fn(),
  getOAuth2Client: vi.fn(),
}));

vi.mock("../db.js", () => {
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === "admin-1")
          return { id: "admin-1", email: "admin@e.com", role: "ADMIN", plan: "FREE" };
        if (where.id === "user-1")
          return { id: "user-1", email: "u@e.com", role: "USER", plan: "FREE" };
        return null;
      }),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 2),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
          id: where.id,
          email: "u@e.com",
          name: "User",
          role: data.role || "USER",
          plan: data.plan || "FREE",
        }),
      ),
      groupBy: vi.fn(async () => [{ plan: "FREE", _count: { id: 2 } }]),
    },
    conversation: { count: vi.fn(async () => 10) },
    message: { count: vi.fn(async () => 100), groupBy: vi.fn(async () => []) },
    notification: { deleteMany: vi.fn(async () => ({})), count: vi.fn(async () => 0) },
    agentLog: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
    },
    pendingAction: { count: vi.fn(async () => 0) },
    tokenUsage: {
      aggregate: vi.fn(async () => ({
        _sum: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      })),
    },
    feedbackEvent: {
      groupBy: vi.fn(async ({ where }: { where: { toolName?: string | null } }) =>
        where.toolName === "briefing_top_action"
          ? [
              { signal: "APPROVED", _count: { signal: 3 } },
              { signal: "REJECTED", _count: { signal: 1 } },
            ]
          : [{ signal: "APPROVED", _count: { signal: 2 } }],
      ),
      deleteMany: vi.fn(async () => ({})),
    },
    automationConfig: { deleteMany: vi.fn(async () => ({})) },
    calendarEvent: { deleteMany: vi.fn(async () => ({})) },
    contact: { deleteMany: vi.fn(async () => ({})) },
    reminder: { deleteMany: vi.fn(async () => ({})) },
    note: { deleteMany: vi.fn(async () => ({})) },
    task: { deleteMany: vi.fn(async () => ({})) },
    commitment: { deleteMany: vi.fn(async () => ({})) },
    userToken: { deleteMany: vi.fn(async () => ({})) },
    evaluation: { deleteMany: vi.fn(async () => ({})) },
    testRun: { deleteMany: vi.fn(async () => ({})) },
    agent: { deleteMany: vi.fn(async () => ({})) },
    workspaceMember: { deleteMany: vi.fn(async () => ({})) },
    waitlist: {
      findMany: vi.fn(async () => Array.from(waitlistById.values())),
      groupBy: vi.fn(async () => []),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return waitlistById.get(where.id) ?? null;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { status: string; approvedAt: Date | null };
        }) => {
          const entry = waitlistById.get(where.id);
          if (!entry) throw new Error("Waitlist entry not found");
          const updated = { ...entry, status: data.status, approvedAt: data.approvedAt };
          waitlistById.set(where.id, updated);
          return updated;
        },
      ),
    },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});

const ADMIN_TOKEN = signToken({ userId: "admin-1", email: "admin@e.com" });
const USER_TOKEN = signToken({ userId: "user-1", email: "u@e.com" });

async function buildApp() {
  const { adminRoutes } = await import("../routes/admin.js");
  const app = Fastify();
  await app.register(adminRoutes, { prefix: "/api/admin" });
  return app;
}

describe("admin routes", () => {
  beforeEach(() => {
    delete process.env.ADMIN_EMAILS;
  });

  it("rejects unauthenticated with 401", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/api/admin/users" })).statusCode).toBe(401);
    await app.close();
  });

  it("rejects non-admin user with 403", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { authorization: `Bearer ${USER_TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("allows admin to list users", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("allows env-listed founder emails to access admin routes", async () => {
    process.env.ADMIN_EMAILS = "founder@example.com, u@e.com";
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { authorization: `Bearer ${USER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("allows admin to get stats", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/stats",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("totalUsers");
    await app.close();
  });

  it("includes trust-loop metrics in ops", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/ops",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().trust.briefingTop3).toMatchObject({
      total: 4,
      useful: 3,
      wrong: 1,
      usefulRate: 0.75,
    });
    expect(res.json().trust.replyNeeded).toMatchObject({
      total: 2,
      useful: 2,
      usefulRate: 1,
    });
    await app.close();
  });

  it("prevents deleting admin users", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/admin/users/admin-1",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/admin/i);
    await app.close();
  });

  it("reports provider cooldown state via /llm-state", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/llm-state",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("activeModel");
    expect(body).toHaveProperty("observedAt");
    expect(Array.isArray(body.providers)).toBe(true);
    if (body.providers.length > 0) {
      const p = body.providers[0];
      expect(p).toHaveProperty("name");
      expect(p).toHaveProperty("quotaKey");
      expect(p).toHaveProperty("unavailable");
    }
    await app.close();
  });

  it("clears provider cooldown state via POST /llm-state/clear", async () => {
    const { markKeyLimited, isKeyLimited, clearFallbackState } = await import(
      "../model-fallback.js"
    );
    clearFallbackState();
    markKeyLimited("openrouter:test-admin", new Error("429 per day"));
    expect(isKeyLimited("openrouter:test-admin")).toBe(true);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/llm-state/clear",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { quotaKey: "openrouter:test-admin" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cleared).toBe("openrouter:test-admin");
    expect(isKeyLimited("openrouter:test-admin")).toBe(false);
    await app.close();
  });

  it("clears every provider when /llm-state/clear is called without a quotaKey", async () => {
    const { markKeyLimited, isKeyLimited, clearFallbackState } = await import(
      "../model-fallback.js"
    );
    clearFallbackState();
    markKeyLimited("openrouter:test-all", new Error("429 per day"));
    markKeyLimited("gemini:test-all", new Error("429 per day"));

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/llm-state/clear",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cleared).toBe("all");
    expect(isKeyLimited("openrouter:test-all")).toBe(false);
    expect(isKeyLimited("gemini:test-all")).toBe(false);
    await app.close();
  });
});

describe("PATCH /api/admin/waitlist/:id", () => {
  beforeEach(() => {
    delete process.env.ADMIN_EMAILS;
    waitlistById.clear();
    sendBetaInviteEmailSpy.mockClear();
  });

  function seedWaitlistEntry(entry: Partial<StoredWaitlist> & { id: string; email: string }) {
    waitlistById.set(entry.id, {
      name: null,
      status: "PENDING",
      approvedAt: null,
      ...entry,
    });
  }

  it("sends an invite email when transitioning PENDING → APPROVED", async () => {
    seedWaitlistEntry({ id: "w-1", email: "applicant@example.com", name: "Applicant" });
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/waitlist/w-1",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { status: "APPROVED" },
    });

    expect(res.statusCode).toBe(200);
    // Invite email is fire-and-forget — let the microtask queue flush.
    await new Promise((resolve) => setImmediate(resolve));
    expect(sendBetaInviteEmailSpy).toHaveBeenCalledWith("applicant@example.com", "Applicant");
  });

  it("does not re-send invite when entry is already APPROVED", async () => {
    seedWaitlistEntry({
      id: "w-2",
      email: "alreadyin@example.com",
      status: "APPROVED",
      approvedAt: new Date(),
    });
    const app = await buildApp();
    await app.inject({
      method: "PATCH",
      url: "/api/admin/waitlist/w-2",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { status: "APPROVED" },
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(sendBetaInviteEmailSpy).not.toHaveBeenCalled();
  });

  it("does not send invite when transitioning to REJECTED", async () => {
    seedWaitlistEntry({ id: "w-3", email: "rejected@example.com" });
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/waitlist/w-3",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { status: "REJECTED" },
    });

    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sendBetaInviteEmailSpy).not.toHaveBeenCalled();
  });

  it("returns 404 when the waitlist entry does not exist", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/waitlist/missing",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { status: "APPROVED" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects invalid status with 400", async () => {
    seedWaitlistEntry({ id: "w-4", email: "x@example.com" });
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/waitlist/w-4",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { status: "GARBAGE" },
    });
    expect(res.statusCode).toBe(400);
  });
});
