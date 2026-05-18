/**
 * Global per-user push rate limiter.
 *
 * Caps how often a user's phone can ring, regardless of which code path
 * triggered the push. In-memory + process-local — good enough for a single
 * Render web instance. If we ever scale horizontally we move this to Redis.
 *
 * DB `Notification` rows are still created by upstream callers, so blocked
 * pushes remain visible via the bell; only the phone ding is suppressed.
 */

import {
  PUSH_CAP_10MIN as CFG_PUSH_CAP_10MIN,
  PUSH_CAP_60MIN as CFG_PUSH_CAP_60MIN,
  PUSH_WINDOW_10MIN_MS as CFG_WINDOW_10MIN,
  PUSH_WINDOW_60MIN_MS as CFG_WINDOW_60MIN,
} from "./config.js";

// Re-export so existing callers (and tests) keep their named imports working.
export const PUSH_WINDOW_10MIN_MS = CFG_WINDOW_10MIN;
export const PUSH_WINDOW_60MIN_MS = CFG_WINDOW_60MIN;
export const PUSH_CAP_10MIN = CFG_PUSH_CAP_10MIN;
export const PUSH_CAP_60MIN = CFG_PUSH_CAP_60MIN;

const history = new Map<string, number[]>();

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check the caps and, if allowed, record the attempt. Blocked attempts are
 * not recorded so a barrage of rejected calls cannot extend the window.
 */
export function recordPushAttempt(userId: string, nowMs: number = Date.now()): RateLimitResult {
  const prev = history.get(userId) ?? [];
  const pruned = prev.filter((t) => nowMs - t < PUSH_WINDOW_60MIN_MS);
  const in10Min = pruned.filter((t) => nowMs - t < PUSH_WINDOW_10MIN_MS).length;
  const in60Min = pruned.length;

  if (in10Min >= PUSH_CAP_10MIN) {
    history.set(userId, pruned);
    return { allowed: false, reason: `10min cap ${in10Min}/${PUSH_CAP_10MIN}` };
  }
  if (in60Min >= PUSH_CAP_60MIN) {
    history.set(userId, pruned);
    return { allowed: false, reason: `60min cap ${in60Min}/${PUSH_CAP_60MIN}` };
  }

  pruned.push(nowMs);
  history.set(userId, pruned);
  return { allowed: true };
}

/** Test-only helper. */
export function resetPushRateLimit(): void {
  history.clear();
}
