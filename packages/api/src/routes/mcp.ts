/**
 * /api/mcp — stateless Streamable HTTP MCP endpoint. Auth is the API key
 * and ONLY the API key (mcp/api-keys.ts; session JWTs are shape-rejected),
 * registered WITHOUT the session preHandlers on purpose. One server +
 * transport per POST, JSON responses (no SSE), so any Streamable HTTP MCP
 * client — Claude, Cursor — connects with a URL and an Authorization
 * header. Rate limit keys on the (hashed) API key, not the caller IP: MCP
 * clients behind one NAT must not share a bucket.
 */

import crypto from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isEntitled } from "../billing/stripe.js";
import { PAYWALL_ENABLED } from "../config.js";
import { prisma } from "../db.js";
import { authenticateApiKey } from "../mcp/api-keys.js";
import { buildMcpServer } from "../mcp/server.js";
import { captureError } from "../sentry.js";

/**
 * Per-key buckets ONLY for syntactically valid klorn_sk_ tokens — anything
 * else (garbage bearers, no header) collapses into one bucket per UNSPOOFABLE
 * ip. Two prior findings live here: hashing an arbitrary header would hand a
 * fresh bucket to every rotated garbage value, and request.ip derives from
 * X-Forwarded-For under trustProxy — the forgeable source the global limiter
 * already refuses (2026-07-21 incident).
 */
export function mcpRateLimitKey(request: FastifyRequest): string {
  const auth = request.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (/^klorn_sk_[0-9a-f]{64}$/.test(token)) {
    // Hash so the raw key never sits in the limiter's in-memory store.
    return `mcp:${crypto.createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
  }
  const cfIp = request.headers["cf-connecting-ip"];
  return `mcp:invalid:${typeof cfIp === "string" && cfIp ? cfIp : (request.socket.remoteAddress ?? "unknown")}`;
}

const RATE_LIMIT = {
  max: 60,
  timeWindow: "1 minute",
  keyGenerator: mcpRateLimitKey,
};

export async function mcpRoutes(app: FastifyInstance) {
  app.post("/", { config: { rateLimit: RATE_LIMIT } }, async (request, reply) => {
    const key = await authenticateApiKey(request.headers.authorization);
    if (!key) {
      return reply.code(401).send({
        error: "A valid Klorn API key is required (Authorization: Bearer klorn_sk_…).",
      });
    }
    const user = await prisma.user.findUnique({
      where: { id: key.userId },
      select: { plan: true, role: true },
    });
    if (!user) return reply.code(401).send({ error: "Key owner not found." });
    // Same posture as the assistant chat surface (requireEntitled): when the
    // paywall is on, MCP must not be a free side door to the identical
    // toolset. Checked here because requireEntitled reads the session's
    // userId, which an API-key request does not carry.
    if (PAYWALL_ENABLED && !isEntitled(user.plan, user.role ?? undefined)) {
      return reply.code(403).send({
        error: "An active subscription is required to use this feature.",
        code: "ENTITLEMENT_REQUIRED",
      });
    }

    const server = buildMcpServer(key.userId, user.plan, {
      keyId: key.keyId,
      permission: key.permission,
    });
    const transport = new StreamableHTTPServerTransport({
      // Stateless: no session ids, every POST self-contained.
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    // The SDK writes to the raw response; hijack so Fastify doesn't also.
    // Hijacking skips the app's onSend hook, so its Cache-Control must be
    // restated by hand — MCP responses carry Gmail-derived PII and must
    // never be cached (index.ts onSend rationale, CASA/ASVS V8).
    reply.hijack();
    reply.raw.setHeader("cache-control", "no-store");
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      captureError(err, { tags: { scope: "mcp.transport" }, extra: { userId: key.userId } });
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ error: "MCP transport failure." }));
      } else {
        reply.raw.end();
      }
    }
  });

  // Stateless mode has no SSE stream to GET and no session to DELETE.
  const postOnly = async (_request: FastifyRequest, reply: import("fastify").FastifyReply) =>
    reply.code(405).send({ error: "Stateless MCP endpoint: POST only." });
  app.get("/", postOnly);
  app.delete("/", postOnly);
}
