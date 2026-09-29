/**
 * API keys — machine credentials for the MCP endpoint, and ONLY the MCP
 * endpoint: requireAuth/getUserId never accept one, so a leaked key's blast
 * radius is the MCP toolset, not the whole account (no billing, no devices,
 * no auth surface). Only the SHA-256 hash is stored — the Device.tokenHash /
 * one-time-token standard — and the raw key is shown once at creation.
 */

import crypto from "node:crypto";
import type { ApiKeyPermissionWire } from "@klorn/contract";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";

const KEY_PREFIX = "klorn_sk_";
/** Chars of the raw key kept for display ("klorn_sk_ab12cd"). */
const DISPLAY_PREFIX_CHARS = 15;
/** Active (unrevoked) keys per user — a bound, not a product tier. */
export const MAX_ACTIVE_KEYS = 5;
/** lastUsedAt bump throttle — see authenticateApiKey. */
const LAST_USED_BUMP_MS = 5 * 60_000;

/** What a key may do over MCP. The same strings as the Prisma enum and the wire type. */
export type ApiKeyPermission = ApiKeyPermissionWire;
/**
 * Runtime values of the wire type — @klorn/contract is type-only, so they
 * cannot be imported from it. `satisfies` keeps them assignable to the wire
 * type; web keeps its own copy (step A3).
 */
export const API_KEY_PERMISSIONS = [
  "read",
  "read_write",
] as const satisfies readonly ApiKeyPermission[];
/** Every key that existed before the column, and every key minted without a choice. */
export const DEFAULT_API_KEY_PERMISSION: ApiKeyPermission = "read";

export function isApiKeyPermission(value: unknown): value is ApiKeyPermission {
  return typeof value === "string" && (API_KEY_PERMISSIONS as readonly string[]).includes(value);
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
 * The permission fails closed: anything but a stored read_write is read.
 */
export async function authenticateApiKey(
  authHeader: string | undefined,
): Promise<{ userId: string; keyId: string; permission: ApiKeyPermission } | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token.startsWith(KEY_PREFIX)) return null;
  const key = (await prisma.apiKey.findUnique({
    where: { keyHash: hashApiKey(token) },
    select: { id: true, userId: true, permission: true, revokedAt: true, lastUsedAt: true },
  })) as {
    id: string;
    userId: string;
    permission: unknown;
    revokedAt: Date | null;
    lastUsedAt: Date | null;
  } | null;
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
    permission: isApiKeyPermission(key.permission) ? key.permission : DEFAULT_API_KEY_PERMISSION,
  };
}
