import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const sendBetaInviteEmailSpy = vi.fn(async () => true);
vi.mock("../mail/email.js", () => ({
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

// Shared by the PATCH and DELETE suites — hoisted out of the PATCH describe so
// both can seed rows without a second copy of the defaults.
function seedWaitlistEntry(entry: Partial<StoredWaitlist> & { id: string; email: string }) {
  waitlistById.set(entry.id, {
    name: null,
    status: "PENDING",
    approvedAt: null,
    ...entry,
  });
}
vi.mock("../mail/gmail.js", () => ({
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
vi.mock("../learning/ontology-overrides.js", () => ({
  refreshOverrideCache: (...args: unknown[]) => refreshOverrideCacheSpy(...args),
  getEffectiveThresholds: vi.fn(() => ({})),
  overriddenKnobs: vi.fn(() => []),
}));

// Force-rebuild route: mock the heavy graph build; assert the route reports the
// engagement footprint of the freshly-built graph.
const buildInteractionGraphSpy = vi.fn(async (_userId: string) => ({
  builtAt: "2026-07-09T00:00:00Z",
  orgImportance: { "acme.com": 0.9 },
  nodes: [
    {
      email: "alice@acme.com",
      name: "Alice",
      score: 70,
      emailCount: 20,
      lastEmailDaysAgo: 1,
      upcomingMeetings: 0,
      tags: ["you_engage"],
      learnedImportance: 0.9,
      outboundCount: 5,
    },
    {
      email: "bob@acme.com",
      name: "Bob",
      score: 30,
      emailCount: 8,
      lastEmailDaysAgo: 2,
      upcomingMeetings: 0,
      tags: ["org_engaged"],
      propagatedImportance: 0.36,
    },
    {
      email: "stranger@x.com",
      name: null,
      score: 12,
      emailCount: 3,
      lastEmailDaysAgo: 5,
      upcomingMeetings: 0,
      tags: [],
    },
  ],
}));
vi.mock("../learning/interaction-graph.js", () => ({
  buildInteractionGraph: (...args: [string]) => buildInteractionGraphSpy(...args),
}));

type StoredProposal = { id: string; status: string; knob: string; proposedValue: number };
const proposalById = new Map<string, StoredProposal>();

type StoredRule = {
  id: string;
  userId: string;
  status: string;
  pattern: string;
  value: string;
  tier: string;
};
const ruleById = new Map<string, StoredRule>();

// Raw SQL issued inside interactive transactions — in practice the set_config
// calls withTenant/withSystem use to bind the RLS context. Hoisted because the
// vi.mock factory below runs before module-level initialisers.
const { rawCalls } = vi.hoisted(() => ({
  rawCalls: [] as Array<{ sql: string; values: unknown[] }>,
}));

function tenantIdsBound(): string[] {
  return rawCalls
    .filter((c) => c.sql.includes("set_config"))
    .filter((c) => c.values[0] === "app.current_user_id")
    .map((c) => String(c.values[1]));
}

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
      // POST /waitlist looks up by email, PATCH /waitlist/:id by id.
      findUnique: vi.fn(async ({ where }: { where: { id?: string; email?: string } }) => {
        if (where.id) return waitlistById.get(where.id) ?? null;
        if (where.email) {
          for (const entry of waitlistById.values()) {
            if (entry.email === where.email) return entry;
          }
        }
        return null;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const entry = waitlistById.get(where.id);
        if (!entry) throw new Error("Waitlist entry not found");
        waitlistById.delete(where.id);
        return entry;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const entry = {
          id: `w-created-${waitlistById.size + 1}`,
          status: "PENDING",
          approvedAt: null,
          ...data,
        } as StoredWaitlist;
        waitlistById.set(entry.id, entry);
        return entry;
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
    // Two call shapes reach this: the batch form (an array of operations) and
    // the interactive form used by withTenant/withSystem, which needs the
    // callback to receive a client whose model mocks are the same ones the
    // non-transactional assertions below inspect.
    $transaction: vi.fn(async (arg: unknown[] | ((tx: unknown) => Promise<unknown>)) =>
      typeof arg === "function" ? arg(prisma) : arg,
    ),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      rawCalls.push({ sql: strings.join("?"), values });
      return 1;
    }),
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
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => proposalById.get(where.id) ?? null,
      ),
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
    learnedRule: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
        const r = ruleById.get(where.id);
        return r && r.userId === where.userId ? r : null;
      }),
      findMany: vi.fn(async ({ where }: { where: { userId: string; status: string } }) =>
        [...ruleById.values()].filter(
          (r) => r.userId === where.userId && r.status === where.status,
        ),
      ),
      // Scoped by userId as well as id: a write that matches no owned row
      // reports count 0 rather than touching another tenant's rule, which is
      // also how the query behaves once RLS binds for real.
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; userId: string };
          data: { status: string };
        }) => {
          const r = ruleById.get(where.id);
          if (!r || r.userId !== where.userId) return { count: 0 };
          ruleById.set(where.id, { ...r, status: data.status });
          return { count: 1 };
        },
      ),
    },
    // Two findMany shapes hit senderTrait: the metrics query (no take, no
    // evidenceText select) and the evidence-inspector query (take:200, selects
    // evidenceText). The inspector mock returns one row so we can assert it is
    // ONLY reached when an explicit userId is provided.
    senderTrait: {
      findMany: vi.fn(
        async ({ take, select }: { take?: number; select?: Record<string, boolean> }) =>
          take === 200 || select?.evidenceText
            ? [
                {
                  sender: "vc@fund.com",
                  factKind: "relationship",
                  factValue: "investor",
                  confidence: 0.9,
                  evidenceText: "we want to invest",
                  status: "active",
                  conflictValue: null,
                  observedCount: 2,
                },
              ]
            : [],
      ),
    },
    emailMessage: { groupBy: vi.fn(async () => []) },
  };
  return {
    prisma,
    db: prisma,
    INTERACTIVE_TX_OPTIONS: { maxWait: 10_000, timeout: 15_000 },
  };
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

  it("force-rebuilds the interaction graph and reports the engagement footprint", async () => {
    buildInteractionGraphSpy.mockClear();
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/interaction-graph/rebuild",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    // Defaults to the acting admin's own account when ?userId= is omitted.
    expect(buildInteractionGraphSpy).toHaveBeenCalledWith("admin-1");
    expect(res.json()).toMatchObject({
      userId: "admin-1",
      nodeCount: 3,
      directlyEngaged: 1, // alice (learnedImportance + outboundCount>0)
      orgPropagated: 1, // bob (propagatedImportance)
      orgImportanceDomains: 1, // acme.com
    });
    await app.close();
  });

  it("targets another user's graph when ?userId= is given (support/dogfood)", async () => {
    buildInteractionGraphSpy.mockClear();
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/interaction-graph/rebuild?userId=user-1",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(buildInteractionGraphSpy).toHaveBeenCalledWith("user-1");
    await app.close();
  });

  it("rejects a non-admin from the graph rebuild with 403", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/interaction-graph/rebuild",
      headers: { authorization: `Bearer ${USER_TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
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

  it("reports the Google unverified-app quota in stats", async () => {
    const { prisma } = (await import("../db.js")) as unknown as {
      prisma: { user: { count: ReturnType<typeof vi.fn> } };
    };
    prisma.user.count.mockClear();
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/stats",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().googleQuota).toEqual({ consumed: 2, cap: 100, remaining: 98 });
    // Consumed must count Google-origin accounts only — no password and no
    // Apple/Naver identity. Counting every user would over-report the slot
    // burn the moment another provider is enabled.
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: { passwordHash: null, identities: { none: {} } },
    });
    await app.close();
  });

  it("clamps the Google quota so an over-cap project never reports negative room", async () => {
    const { prisma } = (await import("../db.js")) as unknown as {
      prisma: { user: { count: ReturnType<typeof vi.fn> } };
    };
    prisma.user.count.mockImplementation(async () => 137);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/stats",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    expect(res.json().googleQuota).toEqual({ consumed: 137, cap: 100, remaining: 0 });
    prisma.user.count.mockImplementation(async () => 2);
    await app.close();
  });

  describe("provider config health", () => {
    const APPLE_VARS = [
      "APPLE_CLIENT_ID",
      "APPLE_TEAM_ID",
      "APPLE_KEY_ID",
      "APPLE_PRIVATE_KEY",
      "APPLE_REDIRECT_URI",
    ] as const;

    afterEach(() => {
      for (const key of APPLE_VARS) delete process.env[key];
      delete process.env.APPLE_LOGIN_ENABLED;
    });

    async function fetchHealth() {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/provider-config",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      await app.close();
      return res;
    }

    it("names the vars that are missing without ever returning a value", async () => {
      process.env.APPLE_LOGIN_ENABLED = "true";
      process.env.APPLE_CLIENT_ID = "ai.klorn.web";
      process.env.APPLE_REDIRECT_URI = "https://api.example/api/auth/apple/callback";
      process.env.APPLE_PRIVATE_KEY =
        "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----";

      const res = await fetchHealth();

      expect(res.statusCode).toBe(200);
      const apple = res.json().apple as { enabled: boolean; missing: string[]; present: string[] };
      expect(apple.enabled).toBe(true);
      expect(apple.missing).toEqual(["APPLE_TEAM_ID", "APPLE_KEY_ID"]);
      expect(apple.present).toContain("APPLE_CLIENT_ID");
      // Booleans and names only — a config screen must never become a way to
      // read the signing key back out.
      expect(JSON.stringify(res.json())).not.toContain("ai.klorn.web");
      expect(JSON.stringify(res.json())).not.toContain("not-a-key");
    });

    it("reports a private key that cannot be parsed as ES256", async () => {
      process.env.APPLE_LOGIN_ENABLED = "true";
      for (const key of APPLE_VARS) process.env[key] = "set";
      // The shape a stripped-newline paste leaves behind.
      process.env.APPLE_PRIVATE_KEY =
        "-----BEGIN PRIVATE KEY-----MIGTAgEAMBMGBy-----END PRIVATE KEY-----";

      const apple = (await fetchHealth()).json().apple as {
        privateKey: { present: boolean; parses: boolean; detail: string };
      };

      expect(apple.privateKey.present).toBe(true);
      expect(apple.privateKey.parses).toBe(false);
      expect(apple.privateKey.detail).toBeTruthy();
    });

    it("passes a well-formed ES256 key", async () => {
      const { generateKeyPair, exportPKCS8 } = await import("jose");
      const { privateKey } = await generateKeyPair("ES256", { extractable: true });
      process.env.APPLE_LOGIN_ENABLED = "true";
      for (const key of APPLE_VARS) process.env[key] = "set";
      process.env.APPLE_PRIVATE_KEY = await exportPKCS8(privateKey);

      const apple = (await fetchHealth()).json().apple as {
        missing: string[];
        privateKey: { parses: boolean };
      };

      expect(apple.missing).toEqual([]);
      expect(apple.privateKey.parses).toBe(true);
    });

    it("reports a dark provider as disabled rather than broken", async () => {
      const naver = (await fetchHealth()).json().naver as { enabled: boolean; missing: string[] };
      expect(naver.enabled).toBe(false);
      expect(naver.missing).toEqual([
        "NAVER_CLIENT_ID",
        "NAVER_CLIENT_SECRET",
        "NAVER_REDIRECT_URI",
      ]);
    });
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

  it("reports fleet judge health via /judge-health (last DB check + top error)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/judge-health",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ lookbackMs: 24 * 60 * 60 * 1000 });
    expect(body).toHaveProperty("lastCheck");
    expect(body).toHaveProperty("topError");
    await app.close();
  });

  it("blocks a non-admin from /judge-health (403)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/judge-health",
      headers: { authorization: `Bearer ${USER_TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("clears provider cooldown state via POST /llm-state/clear", async () => {
    const { markKeyLimited, isKeyLimited, clearFallbackState } = await import(
      "../llm/model-fallback.js"
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
      "../llm/model-fallback.js"
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

describe("DELETE /api/admin/waitlist/:id", () => {
  beforeEach(() => {
    waitlistById.clear();
  });

  it("rejects an unauthenticated caller", async () => {
    seedWaitlistEntry({ id: "w-d0", email: "junk@example.com" });
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/admin/waitlist/w-d0" });
    expect(res.statusCode).toBe(401);
    expect(waitlistById.size).toBe(1);
  });

  it("deletes a PENDING entry", async () => {
    seedWaitlistEntry({ id: "w-d1", email: "probe@example.com" });
    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/admin/waitlist/w-d1",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, deleted: "probe@example.com" });
    expect(waitlistById.size).toBe(0);
  });

  it("deletes a REJECTED entry", async () => {
    seedWaitlistEntry({ id: "w-d2", email: "spam@example.com", status: "REJECTED" });
    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/admin/waitlist/w-d2",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(waitlistById.size).toBe(0);
  });

  it("refuses to delete an APPROVED entry — that row is a live user's access", async () => {
    // With BETA_GATE_ENABLED on, auth.ts:411 / auth.ts:1295 /
    // social-login.ts:142 all gate signup on status === "APPROVED". Deleting
    // the row locks that person out of their own account with no trace.
    seedWaitlistEntry({
      id: "w-d3",
      email: "realuser@example.com",
      status: "APPROVED",
      approvedAt: new Date(),
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/admin/waitlist/w-d3",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Reject this entry before deleting/i);
    expect(waitlistById.size).toBe(1);
  });

  it("returns 404 for an id that does not exist", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/admin/waitlist/missing",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/admin/waitlist", () => {
  // Creation moved here when the public POST /api/waitlist was deleted
  // (2026-08-26). It is the only way a row is created now, and
  // docs/oauth-verification/README.md §3.5 depends on it to pre-provision the
  // Google reviewer and the CASA DAST scanner past BETA_GATE_ENABLED.
  beforeEach(() => {
    waitlistById.clear();
  });

  it("rejects an unauthenticated caller", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/waitlist",
      payload: { email: "reviewer@example.com" },
    });
    expect(res.statusCode).toBe(401);
    expect(waitlistById.size).toBe(0);
  });

  it("creates a PENDING entry for a new address", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/waitlist",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { email: "Reviewer@Example.com ", name: "Google Reviewer" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.created).toBe(true);
    expect(body.entry.status).toBe("PENDING");
    // Normalised, so a later lookup by the address they actually type matches.
    expect(body.entry.email).toBe("reviewer@example.com");
  });

  it("is idempotent — a second call finds the row instead of duplicating it", async () => {
    const app = await buildApp();
    const payload = { email: "dast@example.com" };
    const first = await app.inject({
      method: "POST",
      url: "/api/admin/waitlist",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/admin/waitlist",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().created).toBe(true);
    // 200 not 201, and created:false — behind an admin token there is no
    // enumeration concern, so the caller is told which of the two happened.
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(false);
    expect(waitlistById.size).toBe(1);
  });

  it("rejects a malformed address before touching the database", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/waitlist",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { email: "not-an-email" },
    });
    expect(res.statusCode).toBe(400);
    expect(waitlistById.size).toBe(0);
  });
});

describe("PATCH /api/admin/waitlist/:id", () => {
  beforeEach(() => {
    delete process.env.ADMIN_EMAILS;
    waitlistById.clear();
    sendBetaInviteEmailSpy.mockClear();
  });

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
    const res = await app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
    });
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

describe("GET /api/admin/sender-traits — cross-user evidence gate", () => {
  beforeEach(async () => {
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.senderTrait.findMany).mockClear();
  });

  // The verbatim-evidence findMany is the inspector query (take:200 + selects
  // evidenceText). Distinguish it from the metrics findMany, which selects no
  // evidence and uses no take.
  const evidenceCalls = (calls: unknown[][]) =>
    calls.filter(([arg]) => {
      const a = arg as { take?: number; select?: Record<string, boolean> } | undefined;
      return a?.take === 200 || Boolean(a?.select?.evidenceText);
    });

  it("returns metrics but NO evidence rows when userId is absent", async () => {
    const { prisma } = await import("../db.js");
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/sender-traits",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("metrics");
    expect(body.traits).toEqual([]);
    // The verbatim-evidence query must never run for a cross-user request.
    expect(evidenceCalls(vi.mocked(prisma.senderTrait.findMany).mock.calls)).toHaveLength(0);
    await app.close();
  });

  // Real userIds are UUIDs (schema @default(uuid())); the format guard accepts
  // hex + hyphens, so use a UUID-shaped id here rather than the "user-1" fixture.
  const TRAIT_USER_ID = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";

  it("returns that user's evidence rows when an explicit userId is given", async () => {
    const { prisma } = await import("../db.js");
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/sender-traits?userId=${TRAIT_USER_ID}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.traits).toHaveLength(1);
    expect(body.traits[0].evidenceText).toBe("we want to invest");
    const calls = evidenceCalls(vi.mocked(prisma.senderTrait.findMany).mock.calls);
    expect(calls).toHaveLength(1);
    expect((calls[0][0] as { where: { userId: string } }).where).toEqual({
      userId: TRAIT_USER_ID,
    });
    await app.close();
  });

  it("rejects a malformed userId with 400", async () => {
    const { prisma } = await import("../db.js");
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/sender-traits?userId=" + encodeURIComponent("'; DROP TABLE"),
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid userid/i);
    // A rejected request must touch neither metrics nor evidence queries.
    expect(vi.mocked(prisma.senderTrait.findMany)).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("admin learned-rule approval gate", () => {
  beforeEach(() => {
    delete process.env.ADMIN_EMAILS;
    ruleById.clear();
    rawCalls.length = 0;
  });

  const seed = (id: string, status: string, userId = "admin-1") =>
    ruleById.set(id, {
      id,
      userId,
      status,
      pattern: "sender-domain",
      value: "news.acme.com",
      tier: "SILENT",
    });

  const post = async (url: string, token = ADMIN_TOKEN) => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();
    return res;
  };

  it("lists the user's OPEN and APPLIED rules", async () => {
    seed("r1", "OPEN");
    seed("r2", "APPLIED");
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/learned-rules",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.open).toHaveLength(1);
    expect(body.applied).toHaveLength(1);
    expect(body.open[0].id).toBe("r1");
    await app.close();
  });

  it("approves an OPEN rule → APPLIED", async () => {
    seed("r1", "OPEN");
    const res = await post("/api/admin/learned-rules/r1/approve");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "APPLIED" });
    expect(ruleById.get("r1")?.status).toBe("APPLIED");
  });

  // The RLS trip-wire. These endpoints run through withTenant so that pointing
  // the app at a role RLS can constrain activates isolation with no further
  // code change. If a refactor drops the wrapper the queries keep passing (the
  // app's role bypasses RLS outright today) and the regression is invisible
  // until the day the role switches, at which point the writes go silently
  // dark. Asserting the GUC is bound is the only way to catch that here.
  it("binds the caller's tenant context before mutating on approve", async () => {
    seed("r1", "OPEN");
    await post("/api/admin/learned-rules/r1/approve");
    expect(tenantIdsBound()).toContain("admin-1");
  });

  it("binds the caller's tenant context before mutating on dismiss", async () => {
    seed("r1", "OPEN");
    await post("/api/admin/learned-rules/r1/dismiss");
    expect(tenantIdsBound()).toContain("admin-1");
  });

  it("binds the caller's tenant context before mutating on revert", async () => {
    seed("r1", "APPLIED");
    await post("/api/admin/learned-rules/r1/revert");
    expect(tenantIdsBound()).toContain("admin-1");
  });

  // withTenant skips its transaction while RLS is inert — which is the state
  // production runs in, and the whole point of the wrapper being cheap. This
  // block still needs a transaction for a reason of its own: the status guard
  // and the write must not straddle two connections, or two concurrent callers
  // both read OPEN and both write. Pin the `atomic` opt-in so it cannot be
  // dropped as redundant.
  it("keeps the status guard and the write in one transaction even when RLS is inert", async () => {
    seed("r1", "OPEN");
    const { prisma } = (await import("../db.js")) as unknown as {
      prisma: { $transaction: { mock: { calls: unknown[] } } };
    };
    process.env.RLS_ENFORCEMENT = "off";
    try {
      const before = prisma.$transaction.mock.calls.length;
      const res = await post("/api/admin/learned-rules/r1/approve");
      expect(res.statusCode).toBe(200);
      expect(prisma.$transaction.mock.calls.length).toBe(before + 1);
    } finally {
      process.env.RLS_ENFORCEMENT = "on";
    }
  });

  // Ownership is enforced by the userId filter today and by the policy once
  // the role switches; the write must never be scoped by id alone, or a policy
  // would be the only thing standing between a bad id and another user's row.
  it("never issues a rule write scoped by id alone", async () => {
    seed("r1", "OPEN");
    await post("/api/admin/learned-rules/r1/approve");
    const { prisma } = (await import("../db.js")) as unknown as {
      prisma: { learnedRule: { updateMany: { mock: { calls: [{ where: object }][] } } } };
    };
    const calls = prisma.learnedRule.updateMany.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [args] of calls) {
      expect(args.where).toHaveProperty("userId");
    }
  });

  // The three handlers were folded into one helper, and the 409 bodies are the
  // only thing that distinguishes them. Asserting status codes alone let a
  // reworded message pass review: the dismiss hint used to be unconditional and
  // a refactor quietly narrowed it to APPLIED-only, so dismissing an already
  // DISMISSED rule silently lost "(revert it instead)". Pin the exact strings.
  it.each([
    ["approve", "APPLIED", "Cannot approve a APPLIED rule"],
    ["approve", "DISMISSED", "Cannot approve a DISMISSED rule"],
    ["dismiss", "APPLIED", "Cannot dismiss a APPLIED rule (revert it instead)"],
    ["dismiss", "DISMISSED", "Cannot dismiss a DISMISSED rule (revert it instead)"],
    ["revert", "OPEN", "Cannot revert a OPEN rule"],
    ["revert", "DISMISSED", "Cannot revert a DISMISSED rule"],
  ])("409 body for %s on a %s rule is unchanged", async (verb, status, expected) => {
    seed("r1", status);
    const res = await post(`/api/admin/learned-rules/r1/${verb}`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: expected });
  });

  // The write is scoped by userId, so a row deleted by a concurrent purge
  // matches nothing. Returning 200 for a write that never landed would be a
  // silent false success.
  it("reports 404 when the row vanishes between the guard and the write", async () => {
    seed("r1", "OPEN");
    const { prisma } = (await import("../db.js")) as unknown as {
      prisma: {
        learnedRule: { updateMany: { mockImplementationOnce: (f: () => unknown) => void } };
      };
    };
    prisma.learnedRule.updateMany.mockImplementationOnce(async () => ({ count: 0 }));
    const res = await post("/api/admin/learned-rules/r1/approve");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Learned rule not found" });
  });

  it("blocks double-approve of a non-OPEN rule with 409", async () => {
    seed("r1", "APPLIED");
    const res = await post("/api/admin/learned-rules/r1/approve");
    expect(res.statusCode).toBe(409);
  });

  it("returns 404 approving a missing rule", async () => {
    const res = await post("/api/admin/learned-rules/nope/approve");
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 and leaves another user's rule untouched (ownership scope)", async () => {
    seed("r1", "OPEN", "other-user");
    const res = await post("/api/admin/learned-rules/r1/approve");
    expect(res.statusCode).toBe(404);
    expect(ruleById.get("r1")?.status).toBe("OPEN");
  });

  it("reverts an APPLIED rule → DISMISSED", async () => {
    seed("r1", "APPLIED");
    const res = await post("/api/admin/learned-rules/r1/revert");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "DISMISSED" });
    expect(ruleById.get("r1")?.status).toBe("DISMISSED");
  });

  it("blocks reverting a non-APPLIED rule with 409", async () => {
    seed("r1", "OPEN");
    const res = await post("/api/admin/learned-rules/r1/revert");
    expect(res.statusCode).toBe(409);
  });

  it("dismisses an OPEN rule → 204", async () => {
    seed("r1", "OPEN");
    const res = await post("/api/admin/learned-rules/r1/dismiss");
    expect(res.statusCode).toBe(204);
    expect(ruleById.get("r1")?.status).toBe("DISMISSED");
  });

  it("blocks dismissing an APPLIED rule with 409 (revert it instead)", async () => {
    seed("r1", "APPLIED");
    const res = await post("/api/admin/learned-rules/r1/dismiss");
    expect(res.statusCode).toBe(409);
    expect(ruleById.get("r1")?.status).toBe("APPLIED");
  });

  it("rejects a non-admin from the approval gate with 403", async () => {
    seed("r1", "OPEN");
    const res = await post("/api/admin/learned-rules/r1/approve", USER_TOKEN);
    expect(res.statusCode).toBe(403);
    expect(ruleById.get("r1")?.status).toBe("OPEN");
  });
});
