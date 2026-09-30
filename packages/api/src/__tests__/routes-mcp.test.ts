/**
 * POST /api/mcp — the Model Context Protocol surface. Auth is the API key
 * and ONLY the API key (a JWT is refused); the toolset is the assistant
 * chat's locked-down set minus create_event (chat intercepts it into a
 * review card — MCP has no review surface), so nothing reachable here can
 * send, delete, or write beyond LOW-risk. Stateless Streamable HTTP: one
 * server per request, JSON responses.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keyFindUnique = vi.hoisted(() => vi.fn(async () => null as unknown));
const userFindUnique = vi.hoisted(() => vi.fn(async () => ({ plan: "FREE" }) as unknown));
const executeToolCallMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => JSON.stringify({ ok: true })),
);
const auditCreate = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ id: "audit-1" })));
const auditUpdate = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({})));

vi.mock("../db.js", () => {
  const prisma = {
    apiKey: { findUnique: keyFindUnique, update: vi.fn(async () => ({})) },
    user: { findUnique: userFindUnique },
    mcpWriteAudit: { create: auditCreate, update: auditUpdate },
  };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../agentcore/chat-engine.js", () => ({
  CHAT_TOOL_NAMES: new Set([
    "list_emails",
    "read_email",
    "classify_emails",
    "get_current_time",
    "create_event",
  ]),
}));
vi.mock("../agentcore/tool-executor.js", () => ({
  ALL_TOOLS: [
    "list_emails",
    "read_email",
    "classify_emails",
    "get_current_time",
    "create_event",
    "send_email",
    "delete_email",
    "mark_read",
  ].map((name) => ({
    type: "function",
    function: { name, description: `${name} desc`, parameters: { type: "object", properties: {} } },
  })),
  executeToolCall: executeToolCallMock,
  isToolAllowedForPlan: vi.fn(() => true),
}));

import { hashApiKey, mintApiKey } from "../mcp/api-keys.js";

const MINTED = mintApiKey();

/** `MAX_BATCH_SIZE` in @modelcontextprotocol/sdk server/requestBody (1.30.1+). */
const SDK_MAX_BATCH_SIZE = 100;
const JSONRPC_INVALID_REQUEST = -32600;

function liveKeyRow() {
  return { id: "k1", userId: "u1", revokedAt: null, lastUsedAt: new Date() };
}

async function buildApp() {
  const { mcpRoutes } = await import("../routes/mcp.js");
  const app = Fastify();
  await app.register(mcpRoutes, { prefix: "/api/mcp" });
  return app;
}

function rpc(body: Record<string, unknown>, key: string | null = MINTED.token) {
  return {
    method: "POST" as const,
    url: "/api/mcp",
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload: body,
  };
}

beforeEach(() => {
  keyFindUnique.mockReset();
  keyFindUnique.mockImplementation(async (args: { where: { keyHash: string } }) =>
    args.where.keyHash === hashApiKey(MINTED.token) ? liveKeyRow() : null,
  );
  userFindUnique.mockReset();
  userFindUnique.mockResolvedValue({ plan: "FREE" });
  executeToolCallMock.mockReset();
  executeToolCallMock.mockImplementation(async () => JSON.stringify({ ok: true }));
  auditCreate.mockReset();
  auditCreate.mockImplementation(async () => ({ id: "audit-1" }));
  auditUpdate.mockReset();
  auditUpdate.mockImplementation(async () => ({}));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/mcp", () => {
  it("401s without a key and with a JWT-shaped bearer", async () => {
    const app = await buildApp();
    const none = await app.inject(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, null));
    expect(none.statusCode).toBe(401);
    const jwt = await app.inject(
      rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "eyJx.jwt.token"),
    );
    expect(jwt.statusCode).toBe(401);
    expect(executeToolCallMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers initialize with the klorn server identity", async () => {
    const app = await buildApp();
    const res = await app.inject(
      rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().result.serverInfo.name).toBe("klorn");
    await app.close();
  });

  it("lists the chat toolset minus create_event, and never send/delete", async () => {
    const app = await buildApp();
    const res = await app.inject(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    expect(res.statusCode).toBe(200);
    const names = res.json().result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("list_emails");
    expect(names).toContain("get_current_time");
    expect(names).not.toContain("create_event");
    expect(names).not.toContain("send_email");
    expect(names).not.toContain("delete_email");
    await app.close();
  });

  it("executes an allowed tool via executeToolCall with the key owner's userId", async () => {
    const app = await buildApp();
    const res = await app.inject(
      rpc({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_emails", arguments: { maxResults: 5 } },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(executeToolCallMock).toHaveBeenCalledWith("u1", "list_emails", { maxResults: 5 });
    expect(res.json().result.content[0].text).toBe(JSON.stringify({ ok: true }));
    await app.close();
  });

  it("refuses a tool outside the MCP set as an in-band tool error", async () => {
    const app = await buildApp();
    const res = await app.inject(
      rpc({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "send_email", arguments: {} },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().result.isError).toBe(true);
    expect(executeToolCallMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a JSON-RPC batch over the transport cap before any tool runs", async () => {
    // One POST counts once against the per-key rate limit, so an unbounded
    // batch would multiply tool calls per request. The SDK caps batches from
    // 1.30.1 on; this pins that the cap still reaches our pre-parsed body.
    const app = await buildApp();
    const batch = Array.from({ length: SDK_MAX_BATCH_SIZE + 1 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i,
      method: "tools/call",
      params: { name: "list_emails", arguments: {} },
    }));
    const res = await app.inject({ ...rpc({}), payload: batch });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(JSONRPC_INVALID_REQUEST);
    expect(executeToolCallMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("405s GET (stateless: POST only)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/mcp" });
    expect(res.statusCode).toBe(405);
    await app.close();
  });
});

describe("mcpRateLimitKey", () => {
  const req = (headers: Record<string, string>, remoteAddress = "203.0.113.9") =>
    ({ headers, socket: { remoteAddress } }) as never;

  it("gives a per-key bucket only to a syntactically valid key", async () => {
    const { mcpRateLimitKey } = await import("../routes/mcp.js");
    const a = mcpRateLimitKey(req({ authorization: `Bearer ${MINTED.token}` }));
    expect(a.startsWith("mcp:") && !a.startsWith("mcp:invalid:")).toBe(true);
    expect(a).not.toContain(MINTED.token);
  });

  it("collapses rotated garbage bearers into ONE unspoofable-ip bucket", async () => {
    const { mcpRateLimitKey } = await import("../routes/mcp.js");
    const g1 = mcpRateLimitKey(req({ authorization: "Bearer klorn_sk_notreal" }));
    const g2 = mcpRateLimitKey(req({ authorization: "Bearer totally-different" }));
    const none = mcpRateLimitKey(req({}));
    expect(g1).toBe("mcp:invalid:203.0.113.9");
    expect(g2).toBe(g1);
    expect(none).toBe(g1);
  });

  it("ignores X-Forwarded-For; prefers cf-connecting-ip over the socket", async () => {
    const { mcpRateLimitKey } = await import("../routes/mcp.js");
    const spoofed = mcpRateLimitKey(req({ "x-forwarded-for": "1.2.3.4" }));
    expect(spoofed).toBe("mcp:invalid:203.0.113.9");
    const cf = mcpRateLimitKey(req({ "cf-connecting-ip": "198.51.100.7" }));
    expect(cf).toBe("mcp:invalid:198.51.100.7");
  });
});

// ---------------------------------------------------------------------------
// Step A2a — write gate: read-write keys, audit, per-user cap, mark_read.
// ---------------------------------------------------------------------------

/** The tools MCP served before A2a, in registry order (mocked registry above). */
const LEGACY_TOOL_NAMES = ["list_emails", "read_email", "classify_emails", "get_current_time"];
const ALL_MOCK_TOOL_NAMES = [
  "list_emails",
  "read_email",
  "classify_emails",
  "get_current_time",
  "create_event",
  "send_email",
  "delete_email",
  "mark_read",
];

const unknownToolResult = (name: string) => ({
  content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
  isError: true,
});

type KeyKind = "read" | "rw" | "rw2" | "other";
let seq = 0;
let keys: Record<KeyKind, ReturnType<typeof mintApiKey>>;
let owners: Record<KeyKind, { id: string; userId: string; permission: string }>;

/** Fresh keys AND fresh user ids per test: the write cap and the refused-audit throttle live in module state. */
function setupKeys() {
  seq += 1;
  const userId = `write-user-${seq}`;
  keys = { read: mintApiKey(), rw: mintApiKey(), rw2: mintApiKey(), other: mintApiKey() };
  owners = {
    read: { id: `k-read-${seq}`, userId, permission: "read" },
    rw: { id: `k-rw-${seq}`, userId, permission: "read_write" },
    rw2: { id: `k-rw2-${seq}`, userId, permission: "read_write" },
    other: { id: `k-other-${seq}`, userId: `${userId}-other`, permission: "read_write" },
  };
  keyFindUnique.mockImplementation(async (args: { where: { keyHash: string } }) => {
    const kind = (Object.keys(keys) as KeyKind[]).find(
      (k) => hashApiKey(keys[k].token) === args.where.keyHash,
    );
    return kind ? { ...owners[kind], revokedAt: null, lastUsedAt: new Date() } : null;
  });
}

const call = (kind: KeyKind, name: string, args: Record<string, unknown> = {}) =>
  rpc(
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } },
    keys[kind].token,
  );
const list = (kind: KeyKind) =>
  rpc({ jsonrpc: "2.0", id: 8, method: "tools/list" }, keys[kind].token);

async function toolNames(kind: KeyKind): Promise<string[]> {
  const app = await buildApp();
  const res = await app.inject(list(kind));
  await app.close();
  return res.json().result.tools.map((t: { name: string }) => t.name);
}

/** POST one JSON-RPC batch of `size` mark_read calls and return the per-call responses. */
async function postBatch(kind: KeyKind, size: number): Promise<{ result: McpResultLike }[]> {
  const batch = Array.from({ length: size }, (_, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "tools/call",
    params: { name: "mark_read", arguments: { email_id: `g${i}` } },
  }));
  const app = await buildApp();
  const res = await app.inject({ ...rpc({}, keys[kind].token), payload: batch });
  await app.close();
  return res.json();
}

/** Refused audits are fire-and-forget: give any stray insert a chance to land before asserting none did. */
const settleFireAndForget = () => new Promise((resolve) => setTimeout(resolve, 25));

type McpResultLike = { content: { type: string; text: string }[]; isError?: boolean };

async function callResult(kind: KeyKind, name: string, args: Record<string, unknown> = {}) {
  const app = await buildApp();
  const res = await app.inject(call(kind, name, args));
  await app.close();
  return res.json().result;
}

describe("MCP write gate — ListTools (flag x permission)", () => {
  beforeEach(setupKeys);

  it("flag OFF: a stored read_write key lists exactly today's tools", async () => {
    expect(await toolNames("rw")).toEqual(LEGACY_TOOL_NAMES);
  });

  it("flag ON: a read key still lists exactly today's tools", async () => {
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
    expect(await toolNames("read")).toEqual(LEGACY_TOOL_NAMES);
  });

  it("flag ON: a read_write key additionally lists mark_read, with its ALL_TOOLS definition", async () => {
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
    expect(await toolNames("rw")).toEqual([...LEGACY_TOOL_NAMES, "mark_read"]);
    const app = await buildApp();
    const res = await app.inject(list("rw"));
    await app.close();
    const tool = res.json().result.tools.find((t: { name: string }) => t.name === "mark_read");
    expect(tool).toEqual({
      name: "mark_read",
      description: "mark_read desc",
      inputSchema: { type: "object", properties: {} },
    });
  });

  it("flag ON then OFF: an existing read_write key loses the write tool at once", async () => {
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
    expect(await toolNames("rw")).toContain("mark_read");
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "false");
    expect(await toolNames("rw")).toEqual(LEGACY_TOOL_NAMES);
  });
});

describe("MCP write gate — CallTool (flag x permission)", () => {
  beforeEach(setupKeys);

  it("flag OFF: every tool result is what main returned, for a stored read_write key", async () => {
    for (const name of ALL_MOCK_TOOL_NAMES) {
      const got = await callResult("rw", name, { email_id: "g1" });
      const expected = LEGACY_TOOL_NAMES.includes(name)
        ? { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }
        : unknownToolResult(name);
      expect(JSON.stringify(got), name).toBe(JSON.stringify(expected));
    }
    expect(executeToolCallMock.mock.calls.map((c) => c[1])).toEqual(LEGACY_TOOL_NAMES);
  });

  it("flag ON: every tool result is what main returned, for a read key", async () => {
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
    for (const name of ALL_MOCK_TOOL_NAMES) {
      const got = await callResult("read", name, { email_id: "g1" });
      const expected = LEGACY_TOOL_NAMES.includes(name)
        ? { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }
        : unknownToolResult(name);
      expect(JSON.stringify(got), name).toBe(JSON.stringify(expected));
    }
    expect(executeToolCallMock.mock.calls.map((c) => c[1])).toEqual(LEGACY_TOOL_NAMES);
  });

  it("a read key calling mark_read gets today's Unknown-tool response and never reaches the executor", async () => {
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
    const got = await callResult("read", "mark_read", { email_id: "g1" });
    expect(got).toEqual(unknownToolResult("mark_read"));
    expect(executeToolCallMock).not.toHaveBeenCalled();
  });

  it("the refusal is indistinguishable from calling a tool that does not exist", async () => {
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
    const write = await callResult("read", "mark_read");
    const nonexistent = await callResult("read", "no_such_tool");
    expect(JSON.stringify(write).replace("mark_read", "X")).toBe(
      JSON.stringify(nonexistent).replace("no_such_tool", "X"),
    );
  });

  it("writes a best-effort refused audit row for a read key (permission_denied)", async () => {
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
    await callResult("read", "mark_read", { email_id: "g1" });
    await vi.waitFor(() => expect(auditCreate).toHaveBeenCalledTimes(1));
    const data = (auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      userId: owners.read.userId,
      apiKeyId: owners.read.id,
      tool: "mark_read",
      targetId: "g1",
      outcome: "refused",
      reason: "permission_denied",
    });
    expect(data.argsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("flag OFF: a stored read_write key is refused and NOT audited (flag off means no new side effect)", async () => {
    const got = await callResult("rw", "mark_read", { email_id: "g1" });
    expect(got).toEqual(unknownToolResult("mark_read"));
    await settleFireAndForget();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(executeToolCallMock).not.toHaveBeenCalled();
  });

  it("a refused-audit failure never changes the response", async () => {
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
    auditCreate.mockRejectedValueOnce(new Error("db down"));
    expect(await callResult("read", "mark_read")).toEqual(unknownToolResult("mark_read"));
  });

  it("a slow refused-audit never delays the response (no timing oracle for write tools)", async () => {
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
    auditCreate.mockImplementationOnce(() => new Promise(() => {}));
    expect(await callResult("read", "mark_read")).toEqual(unknownToolResult("mark_read"));
  });

  it("flag OFF: a 100-call mark_read batch writes ZERO audit rows and answers exactly as main", async () => {
    for (const kind of ["read", "rw"] as const) {
      const results = await postBatch(kind, 100);
      expect(results).toHaveLength(100);
      for (const r of results)
        expect(JSON.stringify(r.result)).toBe(JSON.stringify(unknownToolResult("mark_read")));
    }
    await settleFireAndForget();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(auditUpdate).not.toHaveBeenCalled();
    expect(executeToolCallMock).not.toHaveBeenCalled();
  });

  it("flag ON: a 100-call mark_read batch from a read key writes ONE refused row, not 100", async () => {
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
    const results = await postBatch("read", 100);
    expect(results).toHaveLength(100);
    for (const r of results) expect(r.result).toEqual(unknownToolResult("mark_read"));
    await settleFireAndForget();
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0]?.[0]).toMatchObject({
      data: { outcome: "refused", reason: "permission_denied", apiKeyId: owners.read.id },
    });
  });

  it("does not audit read tools or tools outside the write set", async () => {
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
    await callResult("rw", "list_emails");
    await callResult("rw", "send_email");
    await callResult("rw", "no_such_tool");
    expect(auditCreate).not.toHaveBeenCalled();
    expect(auditUpdate).not.toHaveBeenCalled();
  });
});

describe("MCP write gate — allowed write (flag ON, read_write key)", () => {
  beforeEach(() => {
    setupKeys();
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
  });

  it("audits BEFORE executing, then runs mark_read as the key owner and passes the result through", async () => {
    const order: string[] = [];
    auditCreate.mockImplementationOnce(async () => {
      order.push("audit");
      return { id: "audit-77" };
    });
    executeToolCallMock.mockImplementationOnce(async () => {
      order.push("execute");
      return JSON.stringify({ success: true });
    });
    const got = await callResult("rw", "mark_read", { email_id: "g-42" });
    expect(order).toEqual(["audit", "execute"]);
    expect(got).toEqual({ content: [{ type: "text", text: JSON.stringify({ success: true }) }] });
    expect(executeToolCallMock).toHaveBeenCalledWith(owners.rw.userId, "mark_read", {
      email_id: "g-42",
    });
    const data = (auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      userId: owners.rw.userId,
      apiKeyId: owners.rw.id,
      tool: "mark_read",
      targetId: "g-42",
      outcome: "attempted",
      reason: null,
    });
    // Settled only after the tool answered with success:true.
    expect(auditUpdate).toHaveBeenCalledWith({
      where: { id: "audit-77" },
      data: { outcome: "ok", reason: null },
    });
  });

  it("refuses the call when the audit insert fails: explicit error, executor never called", async () => {
    auditCreate.mockRejectedValueOnce(new Error("db down"));
    const got = await callResult("rw", "mark_read", { email_id: "g-42" });
    expect(got.isError).toBe(true);
    expect(JSON.parse(got.content[0].text).error).toMatch(/audit/i);
    expect(executeToolCallMock).not.toHaveBeenCalled();
  });

  it("records outcome=error when execution throws, and still answers in-band", async () => {
    auditCreate.mockResolvedValueOnce({ id: "audit-9" });
    executeToolCallMock.mockRejectedValueOnce(new Error("boom"));
    const got = await callResult("rw", "mark_read", { email_id: "g-42" });
    expect(got).toEqual({
      content: [{ type: "text", text: JSON.stringify({ error: "boom" }) }],
      isError: true,
    });
    expect(auditUpdate).toHaveBeenCalledWith({
      where: { id: "audit-9" },
      data: { outcome: "error", reason: "exception" },
    });
  });

  it("records outcome=error when the executor reports a failure in-band (its normal failure shape)", async () => {
    auditCreate.mockResolvedValueOnce({ id: "audit-10" });
    const failure = JSON.stringify({ error: "Gmail not connected." });
    executeToolCallMock.mockResolvedValueOnce(failure);
    const got = await callResult("rw", "mark_read", { email_id: "g-42" });
    // The response is exactly what the executor produced.
    expect(got).toEqual({ content: [{ type: "text", text: failure }] });
    expect(auditUpdate).toHaveBeenCalledWith({
      where: { id: "audit-10" },
      data: { outcome: "error", reason: "tool_error" },
    });
  });

  it("an audit-settle failure never changes the tool response", async () => {
    executeToolCallMock.mockRejectedValueOnce(new Error("boom"));
    auditUpdate.mockRejectedValueOnce(new Error("db down"));
    const got = await callResult("rw", "mark_read", { email_id: "g-42" });
    expect(got.isError).toBe(true);
    expect(JSON.parse(got.content[0].text).error).toBe("boom");
  });

  it("still serves read tools to a read_write key without touching the audit table", async () => {
    const got = await callResult("rw", "list_emails", { maxResults: 3 });
    expect(got).toEqual({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }] });
    expect(auditCreate).not.toHaveBeenCalled();
  });
});

describe("MCP write gate — per-user write cap", () => {
  const CAP = 30;

  beforeEach(() => {
    setupKeys();
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
  });

  it("is shared by all of one user's keys: two keys cannot double the budget", async () => {
    for (let i = 0; i < CAP; i++) {
      const got = await callResult(i % 2 === 0 ? "rw" : "rw2", "mark_read", { email_id: `g${i}` });
      expect(got.isError, `call ${i + 1}`).toBeUndefined();
    }
    for (const kind of ["rw", "rw2"] as const) {
      const over = await callResult(kind, "mark_read", { email_id: "over" });
      expect(over.isError).toBe(true);
      expect(JSON.parse(over.content[0].text)).toMatchObject({ code: "RATE_LIMITED" });
    }
    expect(executeToolCallMock).toHaveBeenCalledTimes(CAP);
  });

  it("audits an over-cap call as refused with reason rate_limited", async () => {
    for (let i = 0; i < CAP; i++) await callResult("rw", "mark_read", { email_id: `g${i}` });
    auditCreate.mockClear();
    await callResult("rw2", "mark_read", { email_id: "over" });
    await vi.waitFor(() => expect(auditCreate).toHaveBeenCalledTimes(1));
    expect(
      (auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data,
    ).toMatchObject({ apiKeyId: owners.rw2.id, outcome: "refused", reason: "rate_limited" });
  });

  it("cannot be bypassed by a JSON-RPC batch: one POST counts each write call", async () => {
    const batchSize = CAP + 10;
    const batch = Array.from({ length: batchSize }, (_, i) => ({
      jsonrpc: "2.0",
      id: i,
      method: "tools/call",
      params: { name: "mark_read", arguments: { email_id: `g${i}` } },
    }));
    const app = await buildApp();
    const res = await app.inject({ ...rpc({}, keys.rw.token), payload: batch });
    await app.close();
    const results = res.json() as { result: { isError?: boolean } }[];
    expect(results).toHaveLength(batchSize);
    expect(results.filter((r) => r.result.isError === true)).toHaveLength(10);
    expect(executeToolCallMock).toHaveBeenCalledTimes(CAP);
    // 30 attempted rows, and the 10 rate-limited calls collapse into ONE refused row.
    await settleFireAndForget();
    const rows = auditCreate.mock.calls.map((c) => (c[0] as { data: { outcome: string } }).data);
    expect(rows.filter((d) => d.outcome === "attempted")).toHaveLength(CAP);
    expect(rows.filter((d) => d.outcome === "refused")).toHaveLength(1);
  });

  it("keeps separate users independent", async () => {
    for (let i = 0; i < CAP; i++) await callResult("rw", "mark_read", { email_id: `g${i}` });
    expect((await callResult("rw", "mark_read", { email_id: "x" })).isError).toBe(true);
    const other = await callResult("other", "mark_read", { email_id: "x" });
    expect(other.isError).toBeUndefined();
  });

  it("does not spend budget on read tools or on refused (read key) calls", async () => {
    for (let i = 0; i < CAP; i++) await callResult("read", "mark_read", { email_id: `g${i}` });
    for (let i = 0; i < CAP; i++) await callResult("rw", "list_emails");
    // Same user, budget untouched: a full CAP of real writes is still available.
    for (let i = 0; i < CAP; i++) {
      const got = await callResult("rw", "mark_read", { email_id: `w${i}` });
      expect(got.isError, `write ${i + 1}`).toBeUndefined();
    }
  });
});
