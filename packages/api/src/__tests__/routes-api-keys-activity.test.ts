/**
 * Step A3 (docs/providers/unified-platform-plan.md) — the API half.
 *
 *  - GET /api/keys/:id/activity: the newest audit rows of ONE owned key, dark
 *    (an unregistered route, byte for byte) while MCP_WRITE_TOOLS_ENABLED is off.
 *  - GET /api/keys: gains `writeToolsAvailable: true` only while the flag is on,
 *    and is byte-identical to main while it is off.
 */

import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const OWNER = "user-1";

const keyFindMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const keyFindFirst = vi.hoisted(() => vi.fn());
const auditFindMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));

vi.mock("../db.js", () => {
  const prisma = {
    apiKey: {
      findMany: keyFindMany,
      findFirst: keyFindFirst,
      count: vi.fn(async () => 0),
      create: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
    },
    mcpWriteAudit: { findMany: auditFindMany },
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

const TOKEN = signToken({ userId: OWNER, email: "t@e.com" });
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

async function buildApp(opts: { withRateLimit?: boolean } = {}): Promise<FastifyInstance> {
  const { apiKeyRoutes } = await import("../routes/api-keys.js");
  const app = Fastify();
  if (opts.withRateLimit) await app.register(rateLimit, { max: 1000, timeWindow: "1 minute" });
  await app.register(apiKeyRoutes, { prefix: "/api/keys" });
  return app;
}

const activityUrl = (id: string) => `/api/keys/${id}/activity`;
const getActivity = (app: FastifyInstance, id = "k1", headers: Record<string, string> = auth()) =>
  app.inject({ method: "GET", url: activityUrl(id), headers });

const ORIGINAL_FLAG = process.env.MCP_WRITE_TOOLS_ENABLED;

/** One audit row as Prisma returns it — with the columns the route must never forward. */
function auditRow(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `audit-${n}`,
    userId: OWNER,
    apiKeyId: "k1",
    tool: "mark_read",
    targetId: `msg${n}`,
    argsHash: `${"ab".repeat(31)}${String(n).padStart(2, "0")}`,
    outcome: "ok",
    reason: null,
    createdAt: new Date(Date.UTC(2026, 8, 30, 12, 0, 60 - n)),
    ...overrides,
  };
}

beforeEach(() => {
  delete process.env.MCP_WRITE_TOOLS_ENABLED;
  keyFindMany.mockReset();
  keyFindMany.mockResolvedValue([]);
  keyFindFirst.mockReset();
  keyFindFirst.mockResolvedValue({ id: "k1" });
  auditFindMany.mockReset();
  auditFindMany.mockResolvedValue([]);
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.MCP_WRITE_TOOLS_ENABLED;
  else process.env.MCP_WRITE_TOOLS_ENABLED = ORIGINAL_FLAG;
});

describe("GET /api/keys/:id/activity — flag OFF (dark, an unregistered route)", () => {
  it.each([
    ["an authenticated caller", auth()],
    ["an anonymous caller", {}],
    ["a caller with a garbage token", { authorization: "Bearer not-a-token" }],
  ])("answers %s exactly like a route that does not exist", async (_label, headers) => {
    const app = await buildApp();
    const bare = Fastify();
    const dark = await getActivity(app, "k1", headers);
    const missing = await getActivity(bare as unknown as FastifyInstance, "k1", headers);
    expect(dark.statusCode).toBe(404);
    expect(dark.statusCode).toBe(missing.statusCode);
    expect(dark.body).toBe(missing.body);
    expect(dark.headers["content-type"]).toBe(missing.headers["content-type"]);
    await app.close();
    await bare.close();
  });

  it("matches the unregistered shape with a query string and with an odd id", async () => {
    const app = await buildApp();
    const bare = Fastify();
    for (const url of [
      `${activityUrl("k1")}?limit=500`,
      activityUrl("%E2%9C%93"),
      activityUrl("x"),
    ]) {
      const dark = await app.inject({ method: "GET", url, headers: auth() });
      const missing = await bare.inject({ method: "GET", url, headers: auth() });
      expect(dark.statusCode, url).toBe(404);
      expect(dark.body, url).toBe(missing.body);
    }
    await app.close();
    await bare.close();
  });

  it("answers HEAD like the unregistered route too (Fastify derives it from GET)", async () => {
    const app = await buildApp();
    const bare = Fastify();
    const url = activityUrl("k1");
    const dark = await app.inject({ method: "HEAD", url, headers: auth() });
    const missing = await bare.inject({ method: "HEAD", url, headers: auth() });
    expect(dark.statusCode).toBe(404);
    expect(dark.statusCode).toBe(missing.statusCode);
    // A HEAD response has no body on the wire, so status and headers are what a
    // prober sees. (inject() still hands back the unregistered route's 404 body
    // and not the gate's, which is an artefact of the test transport.)
    for (const header of ["content-type", "content-length"]) {
      expect(dark.headers[header], header).toBe(missing.headers[header]);
    }
    expect(keyFindFirst).not.toHaveBeenCalled();
    await app.close();
    await bare.close();
  });

  it("does no database work while dark", async () => {
    const app = await buildApp();
    await getActivity(app);
    await getActivity(app, "k1", {});
    expect(keyFindFirst).not.toHaveBeenCalled();
    expect(auditFindMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("follows the flag per request on one app instance: OFF, ON, OFF", async () => {
    const app = await buildApp();
    const statuses: number[] = [];
    for (const flag of [undefined, "true", "off"]) {
      if (flag === undefined) delete process.env.MCP_WRITE_TOOLS_ENABLED;
      else process.env.MCP_WRITE_TOOLS_ENABLED = flag;
      statuses.push((await getActivity(app)).statusCode);
    }
    expect(statuses).toEqual([404, 200, 404]);
    await app.close();
  });
});

describe("GET /api/keys/:id/activity — flag ON", () => {
  beforeEach(() => {
    process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  });

  it("401s an anonymous caller before any database work", async () => {
    const app = await buildApp();
    const res = await getActivity(app, "k1", {});
    expect(res.statusCode).toBe(401);
    expect(keyFindFirst).not.toHaveBeenCalled();
    expect(auditFindMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns the owned key's rows as exactly tool, outcome, reason, targetId, createdAt", async () => {
    auditFindMany.mockResolvedValue([
      auditRow(1),
      auditRow(2, { outcome: "error", reason: "tool_error", targetId: null }),
    ]);
    const app = await buildApp();
    const res = await getActivity(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      activity: [
        {
          tool: "mark_read",
          outcome: "ok",
          reason: null,
          targetId: "msg1",
          createdAt: "2026-09-30T12:00:59.000Z",
        },
        {
          tool: "mark_read",
          outcome: "error",
          reason: "tool_error",
          targetId: null,
          createdAt: "2026-09-30T12:00:58.000Z",
        },
      ],
    });
    await app.close();
  });

  it("never returns argsHash, nor the row id, user id or key id", async () => {
    const rows = [auditRow(1), auditRow(2)];
    auditFindMany.mockResolvedValue(rows);
    const app = await buildApp();
    const res = await getActivity(app);
    for (const item of res.json().activity) {
      expect(Object.keys(item).sort()).toEqual([
        "createdAt",
        "outcome",
        "reason",
        "targetId",
        "tool",
      ]);
    }
    for (const row of rows) {
      expect(res.body).not.toContain(row.argsHash);
      expect(res.body).not.toContain(row.id);
    }
    expect(res.body).not.toMatch(/argsHash/i);
    const { select } = auditFindMany.mock.calls[0][0] as { select: Record<string, boolean> };
    expect(select).toEqual({
      tool: true,
      outcome: true,
      reason: true,
      targetId: true,
      createdAt: true,
    });
    await app.close();
  });

  it("asks for the 50 newest rows of this key and this user, newest first", async () => {
    const app = await buildApp();
    await getActivity(app, "k1");
    expect(auditFindMany).toHaveBeenCalledTimes(1);
    const args = auditFindMany.mock.calls[0][0] as Record<string, unknown>;
    expect(args.where).toEqual({ apiKeyId: "k1", userId: OWNER });
    expect(args.take).toBe(50);
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    await app.close();
  });

  it("keeps the order the database returned (newest first) and does not re-sort", async () => {
    auditFindMany.mockResolvedValue([auditRow(1), auditRow(2), auditRow(3)]);
    const app = await buildApp();
    const res = await getActivity(app);
    const stamps = res.json().activity.map((a: { createdAt: string }) => a.createdAt);
    expect(stamps).toEqual([...stamps].sort().reverse());
    expect(res.json().activity.map((a: { targetId: string }) => a.targetId)).toEqual([
      "msg1",
      "msg2",
      "msg3",
    ]);
    await app.close();
  });

  it("returns an empty list for a key with no activity", async () => {
    const app = await buildApp();
    const res = await getActivity(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ activity: [] });
    await app.close();
  });

  it("still lists the history of a revoked key it owns", async () => {
    keyFindFirst.mockResolvedValue({ id: "k1", revokedAt: new Date("2026-09-01T00:00:00Z") });
    auditFindMany.mockResolvedValue([auditRow(1)]);
    const app = await buildApp();
    const res = await getActivity(app);
    expect(res.statusCode).toBe(200);
    expect(res.json().activity).toHaveLength(1);
    await app.close();
  });

  it("scopes the ownership lookup to the caller and never reads audit rows for a foreign key", async () => {
    keyFindFirst.mockImplementation(async ({ where }: { where: { id: string; userId: string } }) =>
      where.id === "k-mine" && where.userId === OWNER ? { id: "k-mine" } : null,
    );
    const app = await buildApp();
    const foreign = await getActivity(app, "k-theirs");
    expect(foreign.statusCode).toBe(404);
    expect(auditFindMany).not.toHaveBeenCalled();
    expect(keyFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "k-theirs", userId: OWNER } }),
    );
    await app.close();
  });

  it("answers a foreign id and an unknown id with the identical 404", async () => {
    keyFindFirst.mockImplementation(async ({ where }: { where: { id: string; userId: string } }) =>
      where.id === "k-mine" && where.userId === OWNER ? { id: "k-mine" } : null,
    );
    const app = await buildApp();
    const foreign = await getActivity(app, "k-theirs");
    const unknown = await getActivity(app, "k-does-not-exist");
    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ error: "API key not found" });
    expect(unknown.body).toBe(foreign.body);
    expect(foreign.headers["content-type"]).toBe(unknown.headers["content-type"]);
    await app.close();
  });

  it("rate-limits like its siblings: the 31st request in a minute is a 429", async () => {
    const app = await buildApp({ withRateLimit: true });
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await getActivity(app)).statusCode);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    await app.close();
  });
});

describe("GET /api/keys — writeToolsAvailable", () => {
  const ROWS = [
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
      name: "agent",
      prefix: "klorn_sk_ff00aa",
      permission: "read_write",
      createdAt: new Date("2026-07-01T00:00:00Z"),
      lastUsedAt: new Date("2026-07-02T00:00:00Z"),
      revokedAt: new Date("2026-07-03T00:00:00Z"),
    },
  ];
  const KEYS_JSON =
    '[{"id":"k1","name":"laptop","prefix":"klorn_sk_ab12cd","permission":"read","createdAt":"2026-08-01T00:00:00.000Z","lastUsedAt":null,"revoked":false},' +
    '{"id":"k2","name":"agent","prefix":"klorn_sk_ff00aa","permission":"read_write","createdAt":"2026-07-01T00:00:00.000Z","lastUsedAt":"2026-07-02T00:00:00.000Z","revoked":true}]';

  it("flag OFF: the body is byte-identical to main's — no extra field at all", async () => {
    keyFindMany.mockResolvedValue(ROWS);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/keys", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(`{"keys":${KEYS_JSON}}`);
    expect(res.body).not.toContain("writeToolsAvailable");
    await app.close();
  });

  it('flag OFF with no keys: exactly {"keys":[]}', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/keys", headers: auth() });
    expect(res.body).toBe('{"keys":[]}');
    await app.close();
  });

  it("flag ON: the same keys, plus writeToolsAvailable: true after them", async () => {
    process.env.MCP_WRITE_TOOLS_ENABLED = "true";
    keyFindMany.mockResolvedValue(ROWS);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/keys", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(`{"keys":${KEYS_JSON},"writeToolsAvailable":true}`);
    await app.close();
  });

  it("flag ON with no keys: the field is still reported", async () => {
    process.env.MCP_WRITE_TOOLS_ENABLED = "1";
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/keys", headers: auth() });
    expect(res.json()).toEqual({ keys: [], writeToolsAvailable: true });
    await app.close();
  });

  it("follows the flag per request on one app instance: OFF, ON, OFF", async () => {
    const app = await buildApp();
    const bodies: string[] = [];
    for (const flag of [undefined, "true", "off"]) {
      if (flag === undefined) delete process.env.MCP_WRITE_TOOLS_ENABLED;
      else process.env.MCP_WRITE_TOOLS_ENABLED = flag;
      bodies.push((await app.inject({ method: "GET", url: "/api/keys", headers: auth() })).body);
    }
    expect(bodies).toEqual([
      '{"keys":[]}',
      '{"keys":[],"writeToolsAvailable":true}',
      '{"keys":[]}',
    ]);
    await app.close();
  });
});
