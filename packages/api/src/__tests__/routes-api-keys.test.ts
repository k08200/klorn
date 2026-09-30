/**
 * /api/keys — CRUD for MCP machine credentials. The raw key appears exactly
 * once (creation response); the list never carries hashes; revocation is a
 * userId-scoped timestamp so a foreign id is a no-op, not a leak.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const keyFindMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const keyCount = vi.hoisted(() => vi.fn(async () => 0));
const keyCreate = vi.hoisted(() =>
  vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "k-new", ...data })),
);
const keyUpdateMany = vi.hoisted(() => vi.fn(async () => ({ count: 1 })));

vi.mock("../db.js", () => {
  const prisma = {
    apiKey: {
      findMany: keyFindMany,
      count: keyCount,
      create: keyCreate,
      updateMany: keyUpdateMany,
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
    },
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })) },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

async function buildApp() {
  const { apiKeyRoutes } = await import("../routes/api-keys.js");
  const app = Fastify();
  await app.register(apiKeyRoutes, { prefix: "/api/keys" });
  return app;
}

const ORIGINAL_WRITE_FLAG = process.env.MCP_WRITE_TOOLS_ENABLED;

function postKey(app: Awaited<ReturnType<typeof buildApp>>, payload: unknown) {
  return app.inject({ method: "POST", url: "/api/keys", headers: auth(), payload });
}

beforeEach(() => {
  delete process.env.MCP_WRITE_TOOLS_ENABLED;
  keyFindMany.mockReset();
  keyFindMany.mockResolvedValue([]);
  keyCount.mockReset();
  keyCount.mockResolvedValue(0);
  keyCreate.mockClear();
  keyUpdateMany.mockClear();
});

afterEach(() => {
  if (ORIGINAL_WRITE_FLAG === undefined) delete process.env.MCP_WRITE_TOOLS_ENABLED;
  else process.env.MCP_WRITE_TOOLS_ENABLED = ORIGINAL_WRITE_FLAG;
});

describe("POST /api/keys", () => {
  it("mints a key, returns the raw secret ONCE, stores only the hash", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/keys",
      headers: auth(),
      payload: { name: "claude-desktop" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.key).toMatch(/^klorn_sk_[0-9a-f]{64}$/);
    expect(body.name).toBe("claude-desktop");
    expect(body.prefix).toBe(body.key.slice(0, 15));
    const stored = keyCreate.mock.calls[0][0].data as Record<string, string>;
    expect(stored.keyHash).toBeTruthy();
    expect(stored.keyHash).not.toBe(body.key);
    expect(JSON.stringify(stored)).not.toContain(body.key);
    await app.close();
  });

  it("400s a missing/oversized name and the active-key cap", async () => {
    const app = await buildApp();
    const noName = await app.inject({
      method: "POST",
      url: "/api/keys",
      headers: auth(),
      payload: {},
    });
    expect(noName.statusCode).toBe(400);
    keyCount.mockResolvedValue(5);
    const capped = await app.inject({
      method: "POST",
      url: "/api/keys",
      headers: auth(),
      payload: { name: "one-too-many" },
    });
    expect(capped.statusCode).toBe(400);
    expect(keyCreate).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("GET /api/keys", () => {
  it("lists keys without hashes, with a revoked flag", async () => {
    keyFindMany.mockResolvedValue([
      {
        id: "k1",
        name: "laptop",
        prefix: "klorn_sk_ab12cd",
        permission: "read",
        createdAt: new Date("2026-08-01T00:00:00Z"),
        lastUsedAt: null,
        revokedAt: null,
      },
      {
        id: "k2",
        name: "old",
        prefix: "klorn_sk_ff00aa",
        permission: "read_write",
        createdAt: new Date("2026-07-01T00:00:00Z"),
        lastUsedAt: new Date("2026-07-02T00:00:00Z"),
        revokedAt: new Date("2026-07-03T00:00:00Z"),
      },
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/keys", headers: auth() });
    const { keys } = res.json();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual({
      id: "k1",
      name: "laptop",
      prefix: "klorn_sk_ab12cd",
      permission: "read",
      createdAt: "2026-08-01T00:00:00.000Z",
      lastUsedAt: null,
      revoked: false,
    });
    expect(keys[1].revoked).toBe(true);
    expect(keys[1].permission).toBe("read_write");
    expect(JSON.stringify(keys)).not.toContain("keyHash");
    await app.close();
  });
});

describe("GET /api/keys — permission", () => {
  it("selects the permission column and lists it even while the write flag is OFF", async () => {
    keyFindMany.mockResolvedValue([
      {
        id: "k9",
        name: "agent",
        prefix: "klorn_sk_zz99yy",
        permission: "read_write",
        createdAt: new Date("2026-09-01T00:00:00Z"),
        lastUsedAt: null,
        revokedAt: null,
      },
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/keys", headers: auth() });
    expect(res.json().keys[0].permission).toBe("read_write");
    expect(keyFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ permission: true }) }),
    );
    await app.close();
  });
});

describe("POST /api/keys — permission, write flag OFF (dark)", () => {
  it("mints a read key and the response gains only the granted permission", async () => {
    const app = await buildApp();
    const res = await postKey(app, { name: "laptop" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["id", "key", "name", "permission", "prefix"]);
    expect(body.permission).toBe("read");
    expect(keyCreate).toHaveBeenCalledTimes(1);
    expect(keyCreate.mock.calls[0][0].data).toEqual({
      userId: "user-1",
      name: "laptop",
      keyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      prefix: expect.stringMatching(/^klorn_sk_/),
      permission: "read",
    });
    await app.close();
  });

  it.each([
    ["read_write", "read_write"],
    ["null", null],
    ["an unknown word", "x"],
    ["a number", 42],
    ["an object", { level: "read_write" }],
  ])("ignores permission entirely (%s): 200, stored and echoed as read, no code", async (_l, value) => {
    const app = await buildApp();
    const res = await postKey(app, { name: "agent", permission: value });
    expect(res.statusCode).toBe(200);
    expect(res.json().permission).toBe("read");
    expect(res.json()).not.toHaveProperty("code");
    expect(keyCreate).toHaveBeenCalledTimes(1);
    expect(keyCreate.mock.calls[0][0].data.permission).toBe("read");
    await app.close();
  });
});

describe("POST /api/keys — permission, write flag ON", () => {
  beforeEach(() => {
    process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  });

  it("defaults to read when permission is omitted", async () => {
    const app = await buildApp();
    const res = await postKey(app, { name: "laptop" });
    expect(res.statusCode).toBe(200);
    expect(res.json().permission).toBe("read");
    expect(keyCreate.mock.calls[0][0].data.permission).toBe("read");
    await app.close();
  });

  it("grants an explicit read", async () => {
    const app = await buildApp();
    const res = await postKey(app, { name: "laptop", permission: "read" });
    expect(res.statusCode).toBe(200);
    expect(res.json().permission).toBe("read");
    expect(keyCreate.mock.calls[0][0].data.permission).toBe("read");
    await app.close();
  });

  it("grants read_write and echoes it once, next to the raw key", async () => {
    const app = await buildApp();
    const res = await postKey(app, { name: "agent", permission: "read_write" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.key).toMatch(/^klorn_sk_[0-9a-f]{64}$/);
    expect(body.permission).toBe("read_write");
    expect(keyCreate.mock.calls[0][0].data).toEqual({
      userId: "user-1",
      name: "agent",
      keyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      prefix: expect.stringMatching(/^klorn_sk_/),
      permission: "read_write",
    });
    await app.close();
  });

  it.each([
    ["an unknown word", "admin"],
    ["the wrong case", "READ"],
    ["a hyphenated spelling", "read-write"],
    ["an empty string", ""],
    ["null", null],
    ["a number", 1],
    ["a boolean", true],
    ["an object", { level: "read" }],
    ["an array", ["read"]],
    ["an inherited property name", "constructor"],
  ])("400s an invalid permission (%s) with a stable code and no DB work", async (_l, bad) => {
    const app = await buildApp();
    const res = await postKey(app, { name: "agent", permission: bad });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_API_KEY_PERMISSION");
    expect(keyCount).not.toHaveBeenCalled();
    expect(keyCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns the name error when the name and the permission are both invalid", async () => {
    const app = await buildApp();
    const res = await postKey(app, { name: "", permission: "admin" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/name/i);
    expect(res.json()).not.toHaveProperty("code");
    await app.close();
  });
});

describe("POST /api/keys — permission follows the flag per request", () => {
  it("one app instance: OFF -> read, ON -> read_write, OFF -> read", async () => {
    const app = await buildApp();
    const grants: unknown[] = [];
    for (const flag of [undefined, "1", "off"]) {
      if (flag === undefined) delete process.env.MCP_WRITE_TOOLS_ENABLED;
      else process.env.MCP_WRITE_TOOLS_ENABLED = flag;
      const res = await postKey(app, { name: "agent", permission: "read_write" });
      expect(res.statusCode).toBe(200);
      grants.push(res.json().permission);
    }
    expect(grants).toEqual(["read", "read_write", "read"]);
    await app.close();
  });
});

describe("POST /api/keys — body handling", () => {
  it.each([
    ["flag OFF", undefined],
    ["flag ON", "true"],
  ])("never lets the body set a server-owned field (%s)", async (_l, flag) => {
    if (flag) process.env.MCP_WRITE_TOOLS_ENABLED = flag;
    const app = await buildApp();
    const res = await postKey(app, {
      name: "laptop",
      userId: "attacker",
      keyHash: "chosen-by-caller",
      prefix: "evil",
      revokedAt: "2020-01-01T00:00:00.000Z",
      permission: "read",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().prefix).not.toBe("evil");
    expect(keyCreate.mock.calls[0][0].data).toEqual({
      userId: "user-1",
      name: "laptop",
      keyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      prefix: expect.stringMatching(/^klorn_sk_/),
      permission: "read",
    });
    await app.close();
  });

  it("400s the name for a missing body and for a JSON null body", async () => {
    const app = await buildApp();
    const missing = await app.inject({ method: "POST", url: "/api/keys", headers: auth() });
    const jsonNull = await app.inject({
      method: "POST",
      url: "/api/keys",
      headers: { ...auth(), "content-type": "application/json" },
      payload: "null",
    });
    for (const res of [missing, jsonNull]) {
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/name/i);
    }
    expect(keyCreate).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("DELETE /api/keys/:id", () => {
  it("revokes scoped to the caller's user id", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/keys/k1", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(keyUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "k1", userId: "user-1", revokedAt: null }),
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
    await app.close();
  });
});
