import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Behaviour of the route-auth guard on the REAL route set (registerApiRoutes),
// with only the database stubbed. The guard's job is the session check that
// getUserId never did: a token whose session ended (logged out, kicked, idle,
// revoked by a password reset) must stop working on every guarded route, and a
// missing/invalid token must be a 401 — never the 500 a bare getUserId threw.

type DeviceRow = { id: string; userId: string; lastActiveAt: Date; createdAt: Date };
type UserRow = {
  id: string;
  email: string;
  role: string;
  emailVerified: boolean;
  sessionsInvalidatedAt: Date | null;
};

const store = vi.hoisted(() => ({
  device: null as DeviceRow | null,
  user: null as UserRow | null,
  deviceReads: 0,
}));

vi.mock("../db.js", () => {
  // Anything a handler touches beyond the session check is an inert async stub:
  // these tests are about whether a request gets PAST the guard.
  const stub = (): unknown =>
    new Proxy(() => undefined, {
      get: (_target, prop) => (prop === "then" ? undefined : stub()),
      apply: () => Promise.resolve(null),
    });
  const models: Record<string, unknown> = {
    device: new Proxy(
      {
        findUnique: vi.fn(async () => {
          store.deviceReads += 1;
          return store.device;
        }),
        update: vi.fn(async () => ({})),
      },
      { get: (target, prop) => (prop in target ? target[prop as keyof typeof target] : stub()) },
    ),
    user: new Proxy(
      { findUnique: vi.fn(async () => store.user) },
      { get: (target, prop) => (prop in target ? target[prop as keyof typeof target] : stub()) },
    ),
    $queryRaw: vi.fn(async () => [{ ok: 1 }]),
  };
  const prisma = new Proxy(models, {
    get: (target, prop) => (typeof prop === "string" && prop in target ? target[prop] : stub()),
  });
  return { prisma, db: prisma, INTERACTIVE_TX_OPTIONS: { maxWait: 1, timeout: 1 } };
});

const { signToken, getUserId, requireAuth, AuthenticationRequiredError } = await import(
  "../auth.js"
);
const { handleError } = await import("../error-handler.js");
const { registerApiRoutes } = await import("../register-api-routes.js");
const { requireActiveSession } = await import("../security/route-auth-guard.js");

const USER_ID = "u-guard";
const DAY_MS = 24 * 60 * 60 * 1000;

function liveDevice(lastActiveAt = new Date()): DeviceRow {
  return { id: "d-1", userId: USER_ID, lastActiveAt, createdAt: lastActiveAt };
}

function user(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: USER_ID,
    email: "guard@example.com",
    role: "USER",
    emailVerified: true,
    sessionsInvalidatedAt: null,
    ...overrides,
  };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  app.setErrorHandler(handleError);
  // index.ts's raw-body JSON parser: the Stripe/Paddle signature checks read it.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    const str = (body as string) || "{}";
    (req as unknown as { rawBody: string }).rawBody = str;
    done(null, JSON.parse(str));
  });
  await registerApiRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  store.device = liveDevice();
  store.user = user();
  store.deviceReads = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// The routes that served on a bare signature check before the guard.
const FORMERLY_UNGUARDED: ReadonlyArray<{ method: "GET" | "POST"; url: string }> = [
  { method: "GET", url: "/api/briefing/data" },
  { method: "GET", url: "/api/briefing/status" },
  { method: "GET", url: "/api/briefing/b-1/top-actions/feedback" },
  { method: "POST", url: "/api/briefing/b-1/top-actions/1/feedback" },
  { method: "POST", url: "/api/briefing/b-1/picks/1/open" },
  { method: "GET", url: "/api/briefing/feedback/summary" },
  { method: "POST", url: "/api/briefing/generate" },
];

describe("no or invalid token → 401, never 500", () => {
  it.each(FORMERLY_UNGUARDED)("$method $url without a token is 401", async ({ method, url }) => {
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Authentication required" });
  });

  it.each(FORMERLY_UNGUARDED)("$method $url with a forged token is 401", async ({
    method,
    url,
  }) => {
    const res = await app.inject({ method, url, headers: bearer("not.a.jwt") });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Invalid or expired token" });
  });

  it("closes the formerly public /api/notion/status", async () => {
    const res = await app.inject({ method: "GET", url: "/api/notion/status" });
    expect(res.statusCode).toBe(401);
  });

  it("answers a HEAD probe of a guarded GET with 401 too", async () => {
    const res = await app.inject({ method: "HEAD", url: "/api/briefing/status" });
    expect(res.statusCode).toBe(401);
  });

  it("does not run the handler (no database read past the session check)", async () => {
    await app.inject({ method: "GET", url: "/api/briefing/data" });
    expect(store.deviceReads).toBe(0);
  });
});

describe("an ended session's token is rejected on a formerly unguarded route", () => {
  const token = () => signToken({ userId: USER_ID, email: "guard@example.com" });

  it("lets a live session through", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/briefing/status",
      headers: bearer(token()),
    });
    expect(res.statusCode).not.toBe(401);
  });

  it("rejects a logged-out or device-kicked token (no Device row)", async () => {
    store.device = null;
    const res = await app.inject({
      method: "GET",
      url: "/api/briefing/status",
      headers: bearer(token()),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "DEVICE_KICKED" });
  });

  it("rejects a token issued before a password reset revoked every session", async () => {
    const issued = token();
    store.user = user({ sessionsInvalidatedAt: new Date(Date.now() + 2000) });
    const res = await app.inject({
      method: "GET",
      url: "/api/briefing/data",
      headers: bearer(issued),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "DEVICE_KICKED" });
  });

  it("rejects a session idle past the 30-day window", async () => {
    store.device = liveDevice(new Date(Date.now() - 31 * DAY_MS));
    const res = await app.inject({
      method: "GET",
      url: "/api/briefing/b-1/top-actions/feedback",
      headers: bearer(token()),
    });
    expect(res.statusCode).toBe(401);
  });

  it("checks the session once per request when a route also declares requireAuth", async () => {
    // /api/briefing/today declares requireAuth as a preHandler; the guard ran it
    // at onRequest already, so the second call reuses that verdict.
    const res = await app.inject({
      method: "GET",
      url: "/api/briefing/today",
      headers: bearer(token()),
    });
    expect(res.statusCode).not.toBe(401);
    expect(store.deviceReads).toBe(1);
  });
});

describe("admin routes need a live session AND the admin role", () => {
  const token = () => signToken({ userId: USER_ID, email: "guard@example.com" });

  it("answers 403 to a live non-admin session", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: bearer(token()),
    });
    expect(res.statusCode).toBe(403);
  });

  it("answers 401 to an admin whose session was kicked", async () => {
    store.user = user({ role: "ADMIN" });
    store.device = null;
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: bearer(token()),
    });
    expect(res.statusCode).toBe(401);
  });

  it("answers 401 with no token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/users" });
    expect(res.statusCode).toBe(401);
  });
});

describe("exempt routes keep working without a session", () => {
  it("serves the health probes, including HEAD", async () => {
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "HEAD", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/health/ready" })).statusCode).toBe(200);
  });

  it("serves the pre-login probes", async () => {
    const status = await app.inject({ method: "GET", url: "/api/auth/signup-status" });
    expect(status.statusCode).toBe(200);
    const providers = await app.inject({ method: "GET", url: "/api/auth/providers" });
    expect(providers.statusCode).toBe(200);
  });

  it("lets an already-ended session log out", async () => {
    store.device = null;
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: bearer(signToken({ userId: USER_ID, email: "guard@example.com" })),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("webhooks, cron and MCP still authenticate themselves", () => {
  it("Paddle rejects a missing signature with its own 401", async () => {
    vi.stubEnv("PADDLE_WEBHOOK_SECRET", "pdl_ntfset_test_secret");
    const res = await app.inject({ method: "POST", url: "/api/webhook/paddle", payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Invalid signature" });
  });

  it("Stripe rejects a bad signature with its own 400", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test_secret");
    const res = await app.inject({
      method: "POST",
      url: "/api/webhook/stripe",
      headers: { "stripe-signature": "t=1,v1=bad" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Invalid signature" });
  });

  it("RevenueCat rejects a wrong shared secret with its own 401", async () => {
    vi.stubEnv("REVENUECAT_WEBHOOK_AUTH", "rc-shared-secret-value");
    const res = await app.inject({
      method: "POST",
      url: "/api/webhook/revenuecat",
      headers: { authorization: "wrong" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Unauthorized" });
  });

  it("Telegram rejects a missing secret header", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "telegram-secret-value");
    const res = await app.inject({ method: "POST", url: "/api/telegram/webhook", payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json()).not.toEqual({ error: "Authentication required" });
  });

  it("the cron tick rejects a wrong secret with its own 401", async () => {
    vi.stubEnv("BRIEFING_CRON_SECRET", "cron-secret-at-least-16");
    const res = await app.inject({
      method: "POST",
      url: "/api/cron/briefing-tick",
      headers: { "x-cron-secret": "wrong-secret-value-xx" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, reason: "unauthorized" });
  });

  it("MCP rejects a session JWT and a bad key with its own API-key 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: bearer("klorn_sk_not_a_real_key"),
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/API key/);
  });
});

describe("CORS preflight stays credential-free", () => {
  it("answers a browser preflight for a guarded route with no Authorization header", async () => {
    // Same order as index.ts: cors before the routes, so its OPTIONS route is
    // declared before the guard and its hook answers the preflight first.
    const cors = (await import("@fastify/cors")).default;
    const withCors = Fastify();
    await withCors.register(cors, {
      origin: ["https://app.klorn.ai"],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    });
    await registerApiRoutes(withCors);
    await withCors.ready();
    const res = await withCors.inject({
      method: "OPTIONS",
      url: "/api/briefing/status",
      headers: {
        origin: "https://app.klorn.ai",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    await withCors.close();
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.klorn.ai");
  });
});

describe("getUserId and the demo fallback", () => {
  function fakeRequest(headers: Record<string, string> = {}): FastifyRequest {
    return { headers } as unknown as FastifyRequest;
  }

  function fakeReply() {
    const sent: { code?: number; body?: unknown } = {};
    const reply = {
      code(status: number) {
        sent.code = status;
        return reply;
      },
      send(body: unknown) {
        sent.body = body;
        return reply;
      },
    };
    return { reply: reply as unknown as FastifyReply, sent };
  }

  it("throws a 401 AuthenticationRequiredError, not a plain Error, without a token", () => {
    vi.stubEnv("ENABLE_DEMO_USER", "");
    expect(() => getUserId(fakeRequest())).toThrow(AuthenticationRequiredError);
    try {
      getUserId(fakeRequest());
    } catch (err) {
      expect((err as { statusCode?: number }).statusCode).toBe(401);
    }
  });

  it("still falls back to demo-user in test with ENABLE_DEMO_USER=true", () => {
    vi.stubEnv("ENABLE_DEMO_USER", "true");
    expect(getUserId(fakeRequest())).toBe("demo-user");
  });

  it("guard: lets a credential-less request through only when demo access is enabled", async () => {
    vi.stubEnv("ENABLE_DEMO_USER", "true");
    const open = fakeReply();
    await requireActiveSession(fakeRequest(), open.reply);
    expect(open.sent.code).toBeUndefined();

    vi.stubEnv("ENABLE_DEMO_USER", "");
    const closed = fakeReply();
    await requireActiveSession(fakeRequest(), closed.reply);
    expect(closed.sent.code).toBe(401);
  });

  it("guard: never applies the demo fallback outside development/test", async () => {
    vi.stubEnv("ENABLE_DEMO_USER", "true");
    vi.stubEnv("NODE_ENV", "production");
    const { reply, sent } = fakeReply();
    await requireActiveSession(fakeRequest(), reply);
    expect(sent.code).toBe(401);
  });

  it("guard: a request WITH a token is always fully verified, even in demo mode", async () => {
    vi.stubEnv("ENABLE_DEMO_USER", "true");
    store.device = null;
    const { reply, sent } = fakeReply();
    await requireActiveSession(
      fakeRequest(bearer(signToken({ userId: USER_ID, email: "guard@example.com" }))),
      reply,
    );
    expect(sent.code).toBe(401);
  });

  it("requireAuth does not reuse a verdict for a different token on the same request", async () => {
    const request = fakeRequest(bearer(signToken({ userId: USER_ID, email: "guard@example.com" })));
    await requireAuth(request, fakeReply().reply);
    expect(store.deviceReads).toBe(1);
    (request.headers as Record<string, string>).authorization = `Bearer ${signToken({
      userId: "someone-else",
      email: "x@example.com",
    })}`;
    store.device = null;
    const { reply, sent } = fakeReply();
    await requireAuth(request, reply);
    expect(store.deviceReads).toBe(2);
    expect(sent.code).toBe(401);
  });
});
