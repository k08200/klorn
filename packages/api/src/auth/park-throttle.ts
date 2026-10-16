import type { FastifyRequest } from "fastify";

/**
 * Per-IP cap on the account-link PARK path. The OAuth callbacks are public
 * (the browser arrives without a session) and the Google one is exempt from the
 * global limiter, while a signed state stays valid for 10 minutes and the
 * callback parks whatever `code` it is given. This bounds how fast one client
 * can push entries into auth/pending-links.ts. Login markers never reach it.
 *
 * In memory, fixed window, like the store it protects. No timer: stale windows
 * are pruned when the map grows, and the map itself is bounded.
 */

export const PARK_LIMIT_PER_IP = 30;
export const PARK_WINDOW_MS = 15 * 60 * 1000;
/** Tracked clients before pruning; past it the oldest windows are dropped. */
const MAX_TRACKED_CLIENTS = 10_000;

interface Window {
  readonly count: number;
  readonly resetAt: number;
}

const windows = new Map<string, Window>();

/**
 * The unspoofable client address, keyed exactly like the global limiter
 * (index.ts) and device-calendar.ts: Cloudflare's verified CF-Connecting-IP,
 * else the socket address. Never request.ip, which trusts X-Forwarded-For.
 */
export function parkClientKey(request: FastifyRequest): string {
  const cf = request.headers["cf-connecting-ip"];
  const ip =
    typeof cf === "string" && cf.length > 0 ? cf : (request.socket?.remoteAddress ?? "unknown");
  return `link-park:${ip}`;
}

function prune(now: number): void {
  if (windows.size < MAX_TRACKED_CLIENTS) return;
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
  // Still full of live windows: drop the oldest (Map keeps insertion order).
  for (const key of windows.keys()) {
    if (windows.size < MAX_TRACKED_CLIENTS) break;
    windows.delete(key);
  }
}

/** Count one park attempt for `key`; false once the window's limit is spent. */
export function allowPark(key: string, now: number = Date.now()): boolean {
  prune(now);
  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + PARK_WINDOW_MS });
    return true;
  }
  if (current.count >= PARK_LIMIT_PER_IP) return false;
  windows.set(key, { count: current.count + 1, resetAt: current.resetAt });
  return true;
}

export function _resetParkThrottleForTests(): void {
  windows.clear();
}
