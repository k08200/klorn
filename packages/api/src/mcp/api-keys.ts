/**
 * API keys — machine credentials for the MCP endpoint, and ONLY the MCP
 * endpoint: requireAuth/getUserId never accept one, so a leaked key's blast
 * radius is the MCP toolset, not the whole account (no billing, no devices,
 * no auth surface). Only the SHA-256 hash is stored — the Device.tokenHash /
 * one-time-token standard — and the raw key is shown once at creation.
 */

import crypto from "node:crypto";
import type { ApiKeyPermissionWire } from "@klorn/contract";
import { mcpWriteToolsEnabled } from "../config.js";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";

const KEY_PREFIX = "klorn_sk_";
/** Chars of the raw key kept for display ("klorn_sk_ab12cd"). */
const DISPLAY_PREFIX_CHARS = 15;
/** Active (unrevoked) keys per user — a bound, not a product tier. */
export const MAX_ACTIVE_KEYS = 5;
/** lastUsedAt bump throttle — see authenticateApiKey. */
const LAST_USED_BUMP_MS = 5 * 60_000;

/**
 * Runtime members of the wire type — @klorn/contract is type-only, so they
 * cannot be imported from it. Typed as a Record so that adding a member to
 * ApiKeyPermissionWire fails the build until it is listed here. Web keeps its
 * own copy (step A3).
 */
const PERMISSION_TABLE: Record<ApiKeyPermissionWire, true> = { read: true, read_write: true };
const PERMISSIONS: ReadonlySet<string> = new Set(Object.keys(PERMISSION_TABLE));

/** Every key that existed before the column, and every key minted without a choice. */
export const DEFAULT_API_KEY_PERMISSION: ApiKeyPermissionWire = "read";

export function isApiKeyPermission(value: unknown): value is ApiKeyPermissionWire {
  return typeof value === "string" && PERMISSIONS.has(value);
}

export function hashApiKey(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function mintApiKey(): { token: string; tokenHash: string; prefix: string } {
  const token = `${KEY_PREFIX}${crypto.randomBytes(32).toString("hex")}`;
  return { token, tokenHash: hashApiKey(token), prefix: token.slice(0, DISPLAY_PREFIX_CHARS) };
}

/**
 * Resolve an Authorization header to the key's owner and permission. Null on
 * anything that is not a live key — including JWTs and junk, which are
 * rejected by shape before any DB read. lastUsedAt is bumped fire-and-forget:
 * it is display metadata, and a write failure must never fail the request.
 *
 * `permission` is the EFFECTIVE permission, not the stored one: read_write only
 * when the stored value is exactly read_write AND MCP_WRITE_TOOLS_ENABLED is on
 * right now. With the flag off, every key acts as read, so turning the flag off
 * revokes write use as well as write minting. Anything unexpected is read.
 */
export async function authenticateApiKey(
  authHeader: string | undefined,
): Promise<{ userId: string; keyId: string; permission: ApiKeyPermissionWire } | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token.startsWith(KEY_PREFIX)) return null;
  const key = await prisma.apiKey.findUnique({
    where: { keyHash: hashApiKey(token) },
    select: { id: true, userId: true, permission: true, revokedAt: true, lastUsedAt: true },
  });
  if (!key || key.revokedAt) return null;
  // lastUsedAt is display metadata at minute granularity — throttled so an
  // MCP client polling every few seconds doesn't turn auth into one DB
  // write per request.
  if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > LAST_USED_BUMP_MS) {
    void prisma.apiKey
      .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      .catch((err: unknown) =>
        captureError(err, { tags: { scope: "api-key.last-used" }, extra: { keyId: key.id } }),
      );
  }
  return {
    userId: key.userId,
    keyId: key.id,
    permission: key.permission === "read_write" && mcpWriteToolsEnabled() ? "read_write" : "read",
  };
}
