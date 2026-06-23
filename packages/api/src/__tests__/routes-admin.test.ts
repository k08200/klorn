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

// The approve/revert routes flip a proposal's status then refresh the live
// override cache. Mock the cache so we can assert it's called and drive the
// cacheRefreshed=false path; the read fns keep ontology.js's import happy.
const refreshOverrideCacheSpy = vi.fn(async () => true);
vi.mock("../ontology-overrides.js", () => ({
  refreshOverrideCache: (...args: unknown[]) => refreshOverrideCacheSpy(...args),
  getEffectiveThresholds: vi.fn(() => ({})),
  overriddenKnobs: vi.fn(() => []),
}));

type StoredProposal = { id: string; status: string; knob: string; proposedValue: number };
const proposalById = new Map<string, StoredProposal>();

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
    calibrationSnapshot: {
      findMany: vi.fn(async () => []),
    },
    ontologyProposal: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => proposalById.get(where.id) ?? null),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
          const entry = proposalById.get(where.id);
          if (!entry) throw new Error("OntologyProposal not found");
          const updated = { ...entry, status: data.status };
          proposalById.set(where.id, updated);
          return updated;
        },
      ),
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
    markKeyLimited("openrouter:user:test-admin", new Error("429 per day"));
    expect(isKeyLimited("openrouter:user:test-admin")).toBe(true);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/llm-state/clear",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { quotaKey: "openrouter:user:test-admin" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cleared).toBe("openrouter:user:test-admin");
    expect(isKeyLimited("openrouter:user:test-admin")).toBe(false);
    await app.close();
  });

  it("rejects /llm-state/clear with a malformed quotaKey", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/llm-state/clear",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { quotaKey: "__proto__" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid quotakey/i);
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

describe("GET /api/admin/calibration", () => {
  function snapshotRow(userId: string, dayKey: string, totalItems: number) {
    return {
      id: `${userId}-${dayKey}`,
      userId,
      dayKey,
      createdAt: new Date(`${dayKey}T02:00:00Z`),
      payload: {
        windowDays: 7,
        windowEnd: `${dayKey}T02:00:00.000Z`,
        totalItems,
        manualOverrides: { count: 1, total: totalItems, rate: 0.1 },
        feedbackOverrides: { count: 2, total: totalItems, rate: 0.2 },
        judgeSourceCounts: {
          "fast-path": 1,
          "sender-prior": 2,
          llm: 5,
          "keyword-fallback": 1,
          unknown: 0,
        },
        driftSignal: { deltaMax: 0.12, deltaMaxTier: "QUEUE" },
      },
    };
  }

  it("returns a per-user series with compact KPI entries", async () => {
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.calibrationSnapshot.findMany).mockResolvedValueOnce([
      snapshotRow("user-1", "2026-06-13", 40),
      snapshotRow("user-1", "2026-06-12", 35),
    ] as never);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/calibration?userId=user-1&days=14",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userId).toBe("user-1");
    expect(body.series).toHaveLength(2);
    expect(body.series[0]).toMatchObject({
      dayKey: "2026-06-13",
      totalItems: 40,
      manualOverrides: { count: 1, total: 40, rate: 0.1 },
      driftDeltaMax: 0.12,
    });
    expect(body.series[0].judgeSourceCounts["keyword-fallback"]).toBe(1);
    // Latest full payload rides along for the dashboard detail view.
    expect(body.latest.windowDays).toBe(7);
  });

  it("returns the latest snapshot per user as an overview when no userId is given", async () => {
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.calibrationSnapshot.findMany).mockResolvedValueOnce([
      snapshotRow("user-1", "2026-06-13", 40),
      snapshotRow("user-2", "2026-06-13", 12),
      snapshotRow("user-1", "2026-06-12", 35),
      snapshotRow("user-2", "2026-06-11", 9),
    ] as never);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/calibration",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.overview).toHaveLength(2);
    const u1 = body.overview.find((o: { userId: string }) => o.userId === "user-1");
    expect(u1.dayKey).toBe("2026-06-13");
    expect(u1.totalItems).toBe(40);
  });
});

describe("admin ontology approval gate", () => {
  beforeEach(() => {
    proposalById.clear();
    refreshOverrideCacheSpy.mockClear();
    refreshOverrideCacheSpy.mockResolvedValue(true);
  });

  const seed = (id: string, status: string) =>
    proposalById.set(id, { id, status, knob: "tier.push.confidence", proposedValue: 0.65 });

  const post = async (url: string, token = ADMIN_TOKEN) => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` } });
    await app.close();
    return res;
  };

  it("approves an OPEN proposal → APPLIED + live cache refresh", async () => {
    seed("p1", "OPEN");
    const res = await post("/api/admin/ontology/proposals/p1/approve");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "APPLIED", cacheRefreshed: true });
    expect(proposalById.get("p1")?.status).toBe("APPLIED");
    expect(refreshOverrideCacheSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces cacheRefreshed=false when the live cache refresh fails", async () => {
    seed("p1", "OPEN");
    refreshOverrideCacheSpy.mockResolvedValueOnce(false);
    const res = await post("/api/admin/ontology/proposals/p1/approve");
    expect(res.statusCode).toBe(200);
    expect(res.json().cacheRefreshed).toBe(false);
  });

  it("blocks double-approve of a non-OPEN proposal with 409", async () => {
    seed("p1", "APPLIED");
    const res = await post("/api/admin/ontology/proposals/p1/approve");
    expect(res.statusCode).toBe(409);
    expect(refreshOverrideCacheSpy).not.toHaveBeenCalled();
  });

  it("returns 404 approving a missing proposal", async () => {
    const res = await post("/api/admin/ontology/proposals/nope/approve");
    expect(res.statusCode).toBe(404);
  });

  it("reverts an APPLIED proposal → DISMISSED + cache refresh", async () => {
    seed("p1", "APPLIED");
    const res = await post("/api/admin/ontology/proposals/p1/revert");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "DISMISSED" });
    expect(proposalById.get("p1")?.status).toBe("DISMISSED");
    expect(refreshOverrideCacheSpy).toHaveBeenCalledTimes(1);
  });

  it("blocks reverting a non-APPLIED proposal with 409", async () => {
    seed("p1", "OPEN");
    const res = await post("/api/admin/ontology/proposals/p1/revert");
    expect(res.statusCode).toBe(409);
    expect(refreshOverrideCacheSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-admin from the approval gate with 403", async () => {
    seed("p1", "OPEN");
    const res = await post("/api/admin/ontology/proposals/p1/approve", USER_TOKEN);
    expect(res.statusCode).toBe(403);
    expect(proposalById.get("p1")?.status).toBe("OPEN");
  });
});
