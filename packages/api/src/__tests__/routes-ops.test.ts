import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";
import { clearFallbackState, markKeyLimited } from "../llm/model-fallback.js";

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
}));
vi.mock("../pim/briefing-status.js", () => ({
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

const calendarEventCount = vi.hoisted(() => vi.fn(async (_args?: unknown) => 1));
const calendarEventFindMany = vi.hoisted(() => vi.fn(async (_args?: unknown) => [] as unknown[]));
// One mock serves the auth lookup and the readiness BYOK-presence lookup; a
// test that needs the user's key lanes overrides it for the BYOK select only.
const userFindUnique = vi.hoisted(() =>
  vi.fn(
    async (_args?: unknown): Promise<Record<string, unknown> | null> => ({
      id: "user-1",
      plan: "FREE",
      role: "USER",
    }),
  ),
);

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
    calendarEvent: { count: calendarEventCount, findMany: calendarEventFindMany },
    user: { findUnique: userFindUnique },
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

/** The BYOK-presence lookup the readiness loader makes (select of the two key columns). */
const isByokSelect = (args: unknown) =>
  Boolean(
    (args as { select?: { anthropicApiKey?: boolean } } | undefined)?.select?.anthropicApiKey,
  );

/** The user row answers the BYOK lookup with these (stored, encrypted) keys; every other lookup is unchanged. */
function userHasStoredKeys(keys: { anthropicApiKey?: string; geminiApiKey?: string }) {
  userFindUnique.mockImplementation(async (args?: unknown) =>
    isByokSelect(args)
      ? { anthropicApiKey: keys.anthropicApiKey ?? null, geminiApiKey: keys.geminiApiKey ?? null }
      : { id: "user-1", plan: "FREE", role: "USER" },
  );
}

/** Env with no LLM provider configured, so each test opts its env lanes in explicitly. */
function stubNoProviderEnv() {
  vi.stubEnv("ANTHROPIC_API_KEY", undefined);
  vi.stubEnv("GEMINI_API_KEY", undefined);
  vi.stubEnv("OPENAI_COMPAT_BASE_URL", undefined);
}

async function readAiProviderCheck() {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/ops/readiness", headers: auth() });
  await app.close();
  const body = res.json();
  return {
    res,
    body,
    ai: body.checks.find((check: { key: string }) => check.key === "aiProvider"),
  };
}

describe("ops routes", () => {
  afterEach(() => {
    clearFallbackState();
    vi.unstubAllEnvs();
    userFindUnique.mockReset();
    userFindUnique.mockImplementation(async () => ({ id: "user-1", plan: "FREE", role: "USER" }));
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
    stubNoProviderEnv();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-test");
    vi.stubEnv("GEMINI_API_KEY", "gem-env-test");
    userHasStoredKeys({ anthropicApiKey: "v1:enc-anthropic", geminiApiKey: "v1:enc-gemini" });
    markKeyLimited("anthropic:env");
    markKeyLimited("gemini:env");
    markKeyLimited("anthropic:user:user-1");
    markKeyLimited("gemini:user:user-1");

    const { res, body, ai } = await readAiProviderCheck();

    expect(res.statusCode).toBe(200);
    expect(ai.status).toBe("error");
    expect(ai.detail.unavailableCount).toBe(4);
    expect(ai.message).toMatch(/cooldown/i);
    expect(body.status).toBe("error");
  });

  it("lists an env lane only for a configured env provider", async () => {
    stubNoProviderEnv();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-test");

    const { ai } = await readAiProviderCheck();

    expect(ai.detail.providers.map((p: { quotaKey: string }) => p.quotaKey)).toEqual([
      "anthropic:env",
    ]);
  });

  it("lists a user lane only when the user row holds that BYOK key, and never echoes the key", async () => {
    stubNoProviderEnv();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-test");
    userHasStoredKeys({ anthropicApiKey: "v1:enc-user-anthropic-secret" });

    const { res, ai } = await readAiProviderCheck();

    expect(ai.detail.providers.map((p: { quotaKey: string }) => p.quotaKey)).toEqual([
      "anthropic:env",
      "anthropic:user:user-1",
    ]);
    // Presence only: the loader selects just the two key columns, and the
    // stored value never reaches the response.
    expect(userFindUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { anthropicApiKey: true, geminiApiKey: true },
    });
    expect(res.body).not.toContain("enc-user-anthropic-secret");
  });
});

describe("ops readiness — kill switch (C2)", () => {
  afterEach(() => {
    delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
  });

  /** The where of whichever query counted today's events (a count, or a row read once copies can exist). */
  const countedWhere = async () => {
    calendarEventCount.mockClear();
    calendarEventFindMany.mockClear();
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/api/ops/readiness", headers: auth() });
    await app.close();
    const call = [...calendarEventCount.mock.calls, ...calendarEventFindMany.mock.calls].at(-1);
    return (call?.[0] as { where: Record<string, unknown> }).where;
  };

  it("counts today's events from primary and LOCAL rows only while the linked sync is off", async () => {
    delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
    expect((await countedWhere()).sourceAccountId).toBeNull();
  });

  it("does not narrow the count once the linked sync is on", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    expect(await countedWhere()).not.toHaveProperty("sourceAccountId");
  });
});

describe("ops readiness — events count with linked calendars (C7)", () => {
  afterEach(() => {
    delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
    calendarEventFindMany.mockResolvedValue([]);
  });

  const upcomingEvents = async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/ops/readiness", headers: auth() });
    await app.close();
    const data = res.json().checks.find((check: { key: string }) => check.key === "data");
    return data.detail.upcomingCalendarEvents as number;
  };

  const copy = (id: string, externalId: string, sourceAccountId: string | null) => ({
    id,
    provider: "GOOGLE",
    externalId,
    sourceAccountId,
  });

  it("counts an invite that sits in the primary and a linked calendar once", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    calendarEventFindMany.mockResolvedValue([
      copy("p1", "g-1", null),
      copy("l1", "g-1", "acct-1"),
      copy("p2", "g-2", null),
    ]);
    expect(await upcomingEvents()).toBe(2);
  });

  it("with no linked rows the count is what the database says, flag on or off (identical to main)", async () => {
    calendarEventFindMany.mockResolvedValue([copy("a", "g-1", null), copy("b", "g-2", null)]);

    delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
    calendarEventCount.mockResolvedValueOnce(2);
    expect(await upcomingEvents()).toBe(2); // count() in the database

    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    expect(await upcomingEvents()).toBe(2); // two distinct rows read, nothing to merge
  });
});
