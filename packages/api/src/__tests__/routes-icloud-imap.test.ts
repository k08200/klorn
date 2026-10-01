/**
 * Phase 2: the iCloud connect surface is dark until ICLOUD_INBOX_ENABLED.
 * While the flag is off every /api/icloud-imap route — authenticated or not —
 * answers 404, indistinguishable from a route that doesn't exist (CASA
 * surface freeze: the DAST scan must not see a new auth/IMAP endpoint).
 * With the flag on, the generalized connect route behaves like Naver's but
 * scoped to provider ICLOUD and pinned to imap.mail.me.com:993.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ plan: "PRO", role: "USER" }));

const db = vi.hoisted(() => ({
  findMany: vi.fn(async () => []),
  findUnique: vi.fn(async () => null),
  count: vi.fn(async () => 0),
  upsert: vi.fn(async () => ({ id: "row-1" })),
  deleteMany: vi.fn(async () => ({ count: 0 })),
}));

vi.mock("../db.js", () => {
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ id: "user-1", plan: state.plan, role: state.role })),
      update: vi.fn(async () => ({ id: "user-1" })),
    },
    linkedInboxAccount: db,
    device: {
      findUnique: vi.fn(async () => ({ id: "device-1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../crypto-tokens.js", () => ({ encryptToken: vi.fn(() => "cipher") }));
vi.mock("../mail/imap-sync.js", () => ({
  verifyImapCredentials: vi.fn(async () => ({ ok: true })),
}));

const ORIGINAL_FLAG = process.env.ICLOUD_INBOX_ENABLED;

async function buildApp() {
  vi.resetModules();
  const { signToken } = await import("../auth.js");
  const { imapConnectRoutes } = await import("../routes/imap-connect.js");
  const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
  const { icloudInboxEnabled } = await import("../config.js");
  // No outer auth hook — production index.ts has none either; the route
  // plugin registers its own requireAuth. An outer preHandler would also
  // 401 the truly-unregistered sibling the fingerprint test compares against.
  const app = Fastify();
  await app.register(imapConnectRoutes(IMAP_PROVIDERS.ICLOUD, { gate: icloudInboxEnabled }), {
    prefix: "/api/icloud-imap",
  });
  await app.ready();
  const token = signToken({ userId: "user-1", email: "test@example.com" });
  return { app, headers: { authorization: `Bearer ${token}` } };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.findMany.mockResolvedValue([]);
  db.findUnique.mockResolvedValue(null);
  db.count.mockResolvedValue(0);
  state.plan = "PRO";
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.ICLOUD_INBOX_ENABLED;
  else process.env.ICLOUD_INBOX_ENABLED = ORIGINAL_FLAG;
  vi.resetModules();
});

describe("flag OFF (default) — the surface does not exist", () => {
  it.each([
    ["GET", "/api/icloud-imap/status"],
    ["POST", "/api/icloud-imap/connect"],
    ["POST", "/api/icloud-imap/disconnect"],
  ] as const)("%s %s answers 404 even when authenticated", async (method, url) => {
    delete process.env.ICLOUD_INBOX_ENABLED;
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method,
      url,
      headers,
      ...(method === "POST" ? { payload: { email: "a@icloud.com", password: "app-pass" } } : {}),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("answers 404 unauthenticated too (no auth-shaped 401 leak)", async () => {
    delete process.env.ICLOUD_INBOX_ENABLED;
    const { app } = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/icloud-imap/status" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("is byte-identical to Fastify's default 404 (no body-diff fingerprint)", async () => {
    delete process.env.ICLOUD_INBOX_ENABLED;
    const { app } = await buildApp();
    // A DAST scanner diffing a dark-but-registered route against a truly
    // unregistered sibling must see the same body shape — Fastify's default
    // embeds METHOD:url, so a static "Not Found" message is a fingerprint.
    const gated = await app.inject({ method: "GET", url: "/api/icloud-imap/status" });
    const unregistered = await app.inject({ method: "GET", url: "/api/icloud-imap/nope" });
    expect(gated.statusCode).toBe(404);
    expect(unregistered.statusCode).toBe(404);
    expect(gated.json()).toEqual({
      message: "Route GET:/api/icloud-imap/status not found",
      error: "Not Found",
      statusCode: 404,
    });
    expect(unregistered.json()).toEqual({
      message: "Route GET:/api/icloud-imap/nope not found",
      error: "Not Found",
      statusCode: 404,
    });
    await app.close();
  });
});

describe("flag ON — generalized connect route, provider ICLOUD", () => {
  beforeEach(() => {
    process.env.ICLOUD_INBOX_ENABLED = "true";
  });

  it("GET /status reads only ICLOUD rows", async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/icloud-imap/status", headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ connected: false, accounts: [] });
    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", provider: "ICLOUD" },
      }),
    );
    await app.close();
  });

  it("POST /connect verifies then upserts an ICLOUD row with the default host", async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/icloud-imap/connect",
      headers,
      payload: { email: "me@icloud.com", password: "app-specific-pw" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, email: "me@icloud.com", host: "imap.mail.me.com:993" });
    expect(db.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_provider_email: {
            userId: "user-1",
            provider: "ICLOUD",
            email: "me@icloud.com",
          },
        },
        create: expect.objectContaining({
          provider: "ICLOUD",
          imapHost: "imap.mail.me.com:993",
          imapPasswordCipher: "cipher",
        }),
      }),
    );
    await app.close();
  });

  it("POST /connect rejects an allowlisted host that belongs to ANOTHER provider", async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/icloud-imap/connect",
      headers,
      // imap.naver.com:993 passes the global SSRF allowlist but must not be
      // storable on an ICLOUD row — host↔provider is pinned per route.
      payload: { email: "me@icloud.com", password: "pw-1234", host: "imap.naver.com:993" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("imap.mail.me.com:993");
    expect(db.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  // B2b: a row id is `<prefix>:<email>:<uid>` and a re-keyed one ends `#uv<old>.<ms>`.
  // The address format keeps ':' and '\\' out of the id (AJV `format: "email"`).
  it.each([
    ["a backslash", "a\\b@icloud.com"],
    ["a colon", "a:b@icloud.com"],
  ])("POST /connect rejects an address with %s before verifying", async (_name, email) => {
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/icloud-imap/connect",
      headers,
      payload: { email, password: "app-specific-pw" },
    });
    expect(res.statusCode).toBe(400);
    expect(db.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("POST /connect still enforces the entitlement gate (FREE → 403)", async () => {
    state.plan = "FREE";
    process.env.PAYWALL_ENABLED = "true";
    try {
      const { app, headers } = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/icloud-imap/connect",
        headers,
        payload: { email: "me@icloud.com", password: "pw-1234" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("ENTITLEMENT_REQUIRED");
      await app.close();
    } finally {
      delete process.env.PAYWALL_ENABLED;
    }
  });

  it("POST /disconnect deletes ICLOUD rows only", async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/icloud-imap/disconnect",
      headers,
      payload: { email: "me@icloud.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(db.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", provider: "ICLOUD", email: "me@icloud.com" },
    });
    await app.close();
  });
});
