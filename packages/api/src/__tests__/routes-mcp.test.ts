/**
 * POST /api/mcp — the Model Context Protocol surface. Auth is the API key
 * and ONLY the API key (a JWT is refused); the toolset is the assistant
 * chat's locked-down set minus create_event (chat intercepts it into a
 * review card — MCP has no review surface), so nothing reachable here can
 * send, delete, or write beyond LOW-risk. Stateless Streamable HTTP: one
 * server per request, JSON responses.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const keyFindUnique = vi.hoisted(() => vi.fn(async () => null as unknown));
const userFindUnique = vi.hoisted(() => vi.fn(async () => ({ plan: "FREE" }) as unknown));
const executeToolCallMock = vi.hoisted(() => vi.fn(async () => JSON.stringify({ ok: true })));

vi.mock("../db.js", () => {
  const prisma = {
    apiKey: { findUnique: keyFindUnique, update: vi.fn(async () => ({})) },
    user: { findUnique: userFindUnique },
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
  executeToolCallMock.mockClear();
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
