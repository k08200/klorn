/**
 * Global per-user push rate limiter — persisted to Postgres.
 *
 * Caps how often a user's phone can ring, regardless of which code path or
 * channel (web push, Telegram) triggered the interrupt. One PushRingEvent
 * row per ALLOWED attempt is the source of truth, so the caps survive
 * process restarts (every deploy used to reset the old in-memory window)
 * and hold across horizontal instances.
 *
 * DB `Notification` rows are still created by upstream callers, so blocked
 * pushes remain visible via the bell; only the phone ding is suppressed.
 *
 * Failure mode: fail OPEN. If Postgres is unreachable the push path is
 * already dead (subscriptions live there too) — refusing here would only
 * hide the real error, and a missed rate check is the cheaper failure.
 *
 * Concurrency: count-then-insert is not transactional, so two simultaneous
 * dispatches can each pass the check one ring under the cap. Worst case is
 * one extra ring per concurrent burst — not worth an advisory lock at this
 * volume.
 */

import {
  PUSH_CAP_10MIN as CFG_PUSH_CAP_10MIN,
  PUSH_CAP_60MIN as CFG_PUSH_CAP_60MIN,
  PUSH_WINDOW_10MIN_MS as CFG_WINDOW_10MIN,
  PUSH_WINDOW_60MIN_MS as CFG_WINDOW_60MIN,
} from "../config.js";
import { prisma } from "../db.js";

// Re-export so existing callers (and tests) keep their named imports working.
export const PUSH_WINDOW_10MIN_MS = CFG_WINDOW_10MIN;
export const PUSH_WINDOW_60MIN_MS = CFG_WINDOW_60MIN;
export const PUSH_CAP_10MIN = CFG_PUSH_CAP_10MIN;
export const PUSH_CAP_60MIN = CFG_PUSH_CAP_60MIN;

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check the caps and, if allowed, record the attempt. Blocked attempts are
 * not recorded so a barrage of rejected calls cannot extend the window.
 */
export async function recordPushAttempt(
  userId: string,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const since10Min = new Date(now.getTime() - PUSH_WINDOW_10MIN_MS);
  const since60Min = new Date(now.getTime() - PUSH_WINDOW_60MIN_MS);

  try {
    const [in10Min, in60Min] = await Promise.all([
      prisma.pushRingEvent.count({
        where: { userId, createdAt: { gte: since10Min } },
      }),
      prisma.pushRingEvent.count({
        where: { userId, createdAt: { gte: since60Min } },
      }),
    ]);

    if (in10Min >= PUSH_CAP_10MIN) {
      return { allowed: false, reason: `10min cap ${in10Min}/${PUSH_CAP_10MIN}` };
    }
    if (in60Min >= PUSH_CAP_60MIN) {
      return { allowed: false, reason: `60min cap ${in60Min}/${PUSH_CAP_60MIN}` };
    }

    await prisma.pushRingEvent.create({ data: { userId } });
    // Opportunistic prune: rows past the widest window are dead weight for
    // every future count. Per-user and indexed, so this stays cheap.
    await prisma.pushRingEvent.deleteMany({
      where: { userId, createdAt: { lt: since60Min } },
    });
    return { allowed: true };
  } catch (err) {
    console.warn(`[PUSH] Rate-limit check failed for ${userId} — failing open:`, err);
    return { allowed: true };
  }
}
