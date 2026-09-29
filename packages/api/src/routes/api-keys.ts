/**
 * /api/keys — CRUD for MCP machine credentials (mail/mcp docs: the key
 * authenticates ONLY the MCP endpoint). Session-authenticated like every
 * settings surface; the raw key appears exactly once, in the creation
 * response. Revocation is a userId-scoped timestamp — a foreign id is a
 * no-op, and the row stays listable so the user can see what existed.
 */

import type { ApiKeyWire } from "@klorn/contract";
import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { mcpWriteToolsEnabled } from "../config.js";
import { prisma } from "../db.js";
import {
  type ApiKeyPermission,
  DEFAULT_API_KEY_PERMISSION,
  isApiKeyPermission,
  MAX_ACTIVE_KEYS,
  mintApiKey,
} from "../mcp/api-keys.js";

const MAX_NAME_CHARS = 60;

/** Stable machine-readable codes on POST / permission errors — clients branch on these, not on `error`. */
const CODE_INVALID_PERMISSION = "INVALID_API_KEY_PERMISSION";
const CODE_WRITE_DISABLED = "API_KEY_WRITE_DISABLED";

type PermissionChoice =
  | { ok: true; permission: ApiKeyPermission }
  | { ok: false; status: 400 | 403; error: string; code: string };

/**
 * Validate the requested permission at the route boundary. Only `undefined`
 * means "omitted" (→ read); null and every other non-member is invalid, so a
 * malformed body can never be mistaken for a choice. read_write is refused —
 * not downgraded — while the write flag is off, so a client that asked for
 * write never silently receives a read-only key.
 */
function chooseNewKeyPermission(raw: unknown, writeEnabled: boolean): PermissionChoice {
  if (raw === undefined) return { ok: true, permission: DEFAULT_API_KEY_PERMISSION };
  if (!isApiKeyPermission(raw)) {
    return {
      ok: false,
      status: 400,
      error: 'Key permission must be "read" or "read_write".',
      code: CODE_INVALID_PERMISSION,
    };
  }
  if (raw === "read_write" && !writeEnabled) {
    return {
      ok: false,
      status: 403,
      error: "Read-write API keys are not available yet.",
      code: CODE_WRITE_DISABLED,
    };
  }
  return { ok: true, permission: raw };
}

export async function apiKeyRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: requireAuth }, async (request) => {
    const uid = getUserId(request);
    const rows = await prisma.apiKey.findMany({
      where: { userId: uid },
      select: {
        id: true,
        name: true,
        prefix: true,
        permission: true,
        createdAt: true,
        lastUsedAt: true,
        revokedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    const keys: ApiKeyWire[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      permission: row.permission,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      revoked: row.revokedAt !== null,
    }));
    return { keys };
  });

  app.post(
    "/",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const uid = getUserId(request);
      const { name, permission } =
        (request.body as { name?: string; permission?: unknown } | null) || {};
      const trimmed = typeof name === "string" ? name.trim() : "";
      if (!trimmed || trimmed.length > MAX_NAME_CHARS) {
        return reply
          .code(400)
          .send({ error: `Key name is required (at most ${MAX_NAME_CHARS} characters).` });
      }
      const choice = chooseNewKeyPermission(permission, mcpWriteToolsEnabled());
      if (!choice.ok) {
        return reply.code(choice.status).send({ error: choice.error, code: choice.code });
      }
      const active = await prisma.apiKey.count({ where: { userId: uid, revokedAt: null } });
      if (active >= MAX_ACTIVE_KEYS) {
        return reply
          .code(400)
          .send({ error: `At most ${MAX_ACTIVE_KEYS} active keys — revoke one first.` });
      }
      const minted = mintApiKey();
      const created = await prisma.apiKey.create({
        data: {
          userId: uid,
          name: trimmed,
          keyHash: minted.tokenHash,
          prefix: minted.prefix,
          permission: choice.permission,
        },
      });
      // The ONLY response that ever carries the raw key.
      return { id: created.id, name: trimmed, prefix: minted.prefix, key: minted.token };
    },
  );

  app.delete("/:id", { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const uid = getUserId(request);
    await prisma.apiKey.updateMany({
      where: { id, userId: uid, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: true };
  });
}
