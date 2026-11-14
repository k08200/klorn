import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// requireAuth / requireAdmin when the database cannot answer the session check.
//
// A transient database error (pool timeout, a dropped connection between the
// Singapore API and the Seoul database) used to be caught together with a bad
// JWT and answered 401 — and a 401 signs the web client out. The session was
// never shown to be ended, so the right answer is a retryable 503 that lets no
// request through. Only a definitively missing, revoked or expired session is
// a 401.

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
  deviceError: null as Error | null,
  userError: null as Error | null,
}));

const captureError = vi.hoisted(() => vi.fn());

vi.mock("../sentry.js", () => ({ captureError }));

vi.mock("../db.js", () => {
  const prisma = {
    device: {
      findUnique: vi.fn(async () => {
        if (store.deviceError) throw store.deviceError;
        return store.device;
      }),
      update: vi.fn(async () => ({})),
    },
    user: {
      findUnique: vi.fn(async () => {
        if (store.userError) throw store.userError;
        return store.user;
      }),
    },
  };
  return { prisma, db: prisma };
});

const { signToken, requireAuth, requireAdmin, SESSION_CHECK_UNAVAILABLE_CODE } = await import(
  "../auth.js"
);
const { installRouteAuthGuard } = await import("../security/route-auth-guard.js");

const USER_ID = "u-503";

function liveDevice(): DeviceRow {
  const now = new Date();
  return { id: "d-1", userId: USER_ID, lastActiveAt: now, createdAt: now };
}

function liveUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: USER_ID,
    email: "u503@example.com",
    role: "USER",
    emailVerified: true,
    sessionsInvalidatedAt: null,
    ...overrides,
  };
}

/** What Prisma throws when the pool cannot hand out a connection in time. */
function poolTimeout(): Error {
  const err = new Error("Timed out fetching a new connection from the connection pool.");
  err.name = "PrismaClientKnownRequestError";
  (err as unknown as { code: string }).code = "P2024";
  return err;
}

const handlerCalls = { user: 0, admin: 0, guarded: 0 };
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  app.get("/user", { preHandler: requireAuth }, async (request) => {
    handlerCalls.user += 1;
    return { userId: (request as unknown as { userId: string }).userId };
  });
  app.get("/admin", { preHandler: requireAdmin }, async () => {
    handlerCalls.admin += 1;
    return { ok: true };
  });
  // The default-deny guard puts requireAuth (via requireActiveSession) in front
  // of every route at onRequest.
  await app.register(async (scope) => {
    installRouteAuthGuard(scope);
    scope.get("/guarded", async () => {
      handlerCalls.guarded += 1;
      return { ok: true };
    });
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  store.device = liveDevice();
  store.user = liveUser();
  store.deviceError = null;
  store.userError = null;
  handlerCalls.user = 0;
  handlerCalls.admin = 0;
  handlerCalls.guarded = 0;
  captureError.mockClear();
});

function bearer(token = signToken({ userId: USER_ID, email: "u503@example.com" })) {
  return { authorization: `Bearer ${token}` };
}

describe("requireAuth: the database cannot answer → 503, never 401", () => {
  it("answers a retryable 503 when the device lookup throws", async () => {
    store.deviceError = poolTimeout();
    const res = await app.inject({ method: "GET", url: "/user", headers: bearer() });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: expect.any(String),
      code: SESSION_CHECK_UNAVAILABLE_CODE,
      retryable: true,
    });
    expect(res.headers["retry-after"]).toMatch(/^\d+$/);
    expect(handlerCalls.user).toBe(0);
  });

  it("answers 503 when the revocation-epoch lookup throws", async () => {
    store.userError = poolTimeout();
    const res = await app.inject({ method: "GET", url: "/user", headers: bearer() });

    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe(SESSION_CHECK_UNAVAILABLE_CODE);
    expect(handlerCalls.user).toBe(0);
  });

  it("reports the failure (it is logged, not swallowed)", async () => {
    const err = poolTimeout();
    store.deviceError = err;
    await app.inject({ method: "GET", url: "/user", headers: bearer() });

    expect(captureError).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ tags: expect.objectContaining({ scope: "auth.session-check" }) }),
    );
  });

  it("does not leak the database error text", async () => {
    store.deviceError = poolTimeout();
    const res = await app.inject({ method: "GET", url: "/user", headers: bearer() });

    expect(res.body).not.toContain("connection pool");
    expect(res.body).not.toContain("P2024");
  });

  it("still answers 401 when one check definitively ended the session and the other failed", async () => {
    store.device = null; // logged out / kicked: definitive
    store.userError = poolTimeout();
    const res = await app.inject({ method: "GET", url: "/user", headers: bearer() });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("DEVICE_KICKED");
    expect(handlerCalls.user).toBe(0);
  });

  it("runs the full check again on the next request once the database is back", async () => {
    store.deviceError = poolTimeout();
    const failed = await app.inject({ method: "GET", url: "/user", headers: bearer() });
    expect(failed.statusCode).toBe(503);

    store.deviceError = null;
    const ok = await app.inject({ method: "GET", url: "/user", headers: bearer() });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ userId: USER_ID });
  });
});

describe("requireAuth: a definitively ended or invalid session → 401", () => {
  it("rejects a token issued before a password reset revoked every session", async () => {
    store.user = liveUser({ sessionsInvalidatedAt: new Date(Date.now() + 60_000) });
    const res = await app.inject({ method: "GET", url: "/user", headers: bearer() });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("DEVICE_KICKED");
    expect(handlerCalls.user).toBe(0);
  });

  it("rejects a logged-out or kicked session (no Device row)", async () => {
    store.device = null;
    const res = await app.inject({ method: "GET", url: "/user", headers: bearer() });

    expect(res.statusCode).toBe(401);
    expect(handlerCalls.user).toBe(0);
  });

  it("rejects a forged token without touching the database", async () => {
    store.deviceError = poolTimeout();
    store.userError = poolTimeout();
    const res = await app.inject({
      method: "GET",
      url: "/user",
      headers: bearer("not.a.jwt"),
    });

    expect(res.statusCode).toBe(401);
    expect(captureError).not.toHaveBeenCalled();
    expect(handlerCalls.user).toBe(0);
  });

  it("rejects a request with no token", async () => {
    const res = await app.inject({ method: "GET", url: "/user" });
    expect(res.statusCode).toBe(401);
  });
});

describe("requireAuth: a live session passes", () => {
  it("lets a live session through and attaches its user", async () => {
    const res = await app.inject({ method: "GET", url: "/user", headers: bearer() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: USER_ID });
    expect(handlerCalls.user).toBe(1);
  });
});

describe("the default-deny guard inherits the 503", () => {
  it("answers 503 and never runs a guarded handler when the database throws", async () => {
    store.deviceError = poolTimeout();
    const res = await app.inject({ method: "GET", url: "/guarded", headers: bearer() });

    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe(SESSION_CHECK_UNAVAILABLE_CODE);
    expect(handlerCalls.guarded).toBe(0);
  });

  it("lets a live session through the guard", async () => {
    const res = await app.inject({ method: "GET", url: "/guarded", headers: bearer() });
    expect(res.statusCode).toBe(200);
    expect(handlerCalls.guarded).toBe(1);
  });
});

describe("requireAdmin: same split", () => {
  it("answers 503, not 401, when the database throws", async () => {
    store.user = liveUser({ role: "ADMIN" });
    store.userError = poolTimeout();
    const res = await app.inject({ method: "GET", url: "/admin", headers: bearer() });

    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe(SESSION_CHECK_UNAVAILABLE_CODE);
    expect(handlerCalls.admin).toBe(0);
  });

  it("answers 503 when only the device lookup throws", async () => {
    store.user = liveUser({ role: "ADMIN" });
    store.deviceError = poolTimeout();
    const res = await app.inject({ method: "GET", url: "/admin", headers: bearer() });

    expect(res.statusCode).toBe(503);
    expect(handlerCalls.admin).toBe(0);
  });

  it("answers 401 to an admin whose session was revoked", async () => {
    store.user = liveUser({ role: "ADMIN", sessionsInvalidatedAt: new Date(Date.now() + 60_000) });
    const res = await app.inject({ method: "GET", url: "/admin", headers: bearer() });

    expect(res.statusCode).toBe(401);
    expect(handlerCalls.admin).toBe(0);
  });

  it("answers 403 to a live non-admin and 200 to a live admin", async () => {
    const denied = await app.inject({ method: "GET", url: "/admin", headers: bearer() });
    expect(denied.statusCode).toBe(403);

    store.user = liveUser({ role: "ADMIN" });
    const allowed = await app.inject({ method: "GET", url: "/admin", headers: bearer() });
    expect(allowed.statusCode).toBe(200);
    expect(handlerCalls.admin).toBe(1);
  });
});
