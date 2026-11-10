/**
 * /api/mcp entitlement posture — with the paywall ON, MCP must refuse a
 * non-entitled plan exactly like the chat surface does (requireEntitled):
 * the identical toolset must not have a free side door. Config is mocked at
 * the module boundary because PAYWALL_ENABLED is boot-frozen.
 */

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

const keyFindUnique = vi.hoisted(() => vi.fn(async () => null as unknown));

vi.mock("../config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config.js")>();
  return { ...original, PAYWALL_ENABLED: true };
});
vi.mock("../db.js", () => {
  const prisma = {
    apiKey: { findUnique: keyFindUnique, update: vi.fn(async () => ({})) },
    user: { findUnique: vi.fn(async () => ({ plan: "FREE", role: "USER" })) },
  };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../agentcore/chat-engine.js", () => ({ CHAT_TOOL_NAMES: new Set(["get_current_time"]) }));
vi.mock("../agentcore/tool-executor.js", () => ({
  ALL_TOOLS: [],
  executeToolCall: vi.fn(),
  isToolAllowedForPlan: vi.fn(() => true),
}));

import { hashApiKey, mintApiKey } from "../mcp/api-keys.js";

describe("paywall ON", () => {
  it("403s a FREE-plan key with ENTITLEMENT_REQUIRED", async () => {
    const minted = mintApiKey();
    keyFindUnique.mockImplementation(async (args: { where: { keyHash: string } }) =>
      args.where.keyHash === hashApiKey(minted.token)
        ? { id: "k1", userId: "u1", revokedAt: null, lastUsedAt: new Date() }
        : null,
    );
    const { mcpRoutes } = await import("../routes/mcp.js");
    const app = Fastify();
    await app.register(mcpRoutes, { prefix: "/api/mcp" });
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: {
        authorization: `Bearer ${minted.token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("ENTITLEMENT_REQUIRED");
    await app.close();
  });
});
