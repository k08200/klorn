/**
 * Global per-user push rate limiter — persisted to Postgres.
 *
 * Caps how often a user's phone can ring, regardless of which code path or
 * channel (web push, Telegram) triggered the interrupt. One PushRingEvent
 * row per ALLOWED attempt is the source of truth, so the caps survive
 * process restarts (every deploy used to reset the old in-memory window)
 * and hold across horizontal instances.
 *
 * Two independent buckets (push-bucket.ts): urgent mail and meeting alerts
 * count only "interrupt" rows, everything else only "ambient" rows, each
 * against its own caps over the same two windows. Briefings and proposals can
 * therefore never use up the room an urgent mail needs, and an interrupt
 * burst never silences the briefing.
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
  PUSH_WINDOW_10MIN_MS as CFG_WINDOW_10MIN,
  PUSH_WINDOW_60MIN_MS as CFG_WINDOW_60MIN,
  PUSH_AMBIENT_CAP_10MIN,
  PUSH_AMBIENT_CAP_60MIN,
  PUSH_INTERRUPT_CAP_10MIN,
  PUSH_INTERRUPT_CAP_60MIN,
} from "../config.js";
import { prisma } from "../db.js";
import type { PushBucket } from "./push-bucket.js";

// Re-export so existing callers (and tests) keep their named imports working.
export const PUSH_WINDOW_10MIN_MS = CFG_WINDOW_10MIN;
export const PUSH_WINDOW_60MIN_MS = CFG_WINDOW_60MIN;

export interface PushBucketCaps {
  per10Min: number;
  per60Min: number;
}

export const PUSH_BUCKET_CAPS: Readonly<Record<PushBucket, PushBucketCaps>> = {
  interrupt: { per10Min: PUSH_INTERRUPT_CAP_10MIN, per60Min: PUSH_INTERRUPT_CAP_60MIN },
  ambient: { per10Min: PUSH_AMBIENT_CAP_10MIN, per60Min: PUSH_AMBIENT_CAP_60MIN },
};

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check the bucket's caps and, if allowed, record the attempt in that bucket.
 * Blocked attempts are not recorded so a barrage of rejected calls cannot
 * extend the window.
 */
export async function recordPushAttempt(
  userId: string,
  bucket: PushBucket,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const caps = PUSH_BUCKET_CAPS[bucket];
  const since10Min = new Date(now.getTime() - PUSH_WINDOW_10MIN_MS);
  const since60Min = new Date(now.getTime() - PUSH_WINDOW_60MIN_MS);

  try {
    const [in10Min, in60Min] = await Promise.all([
      prisma.pushRingEvent.count({
        where: { userId, bucket, createdAt: { gte: since10Min } },
      }),
      prisma.pushRingEvent.count({
        where: { userId, bucket, createdAt: { gte: since60Min } },
      }),
    ]);

    if (in10Min >= caps.per10Min) {
      return { allowed: false, reason: `10min cap ${in10Min}/${caps.per10Min}` };
    }
    if (in60Min >= caps.per60Min) {
      return { allowed: false, reason: `60min cap ${in60Min}/${caps.per60Min}` };
    }

    await prisma.pushRingEvent.create({ data: { userId, bucket } });
    // Opportunistic prune: rows past the widest window are dead weight for
    // every future count, whichever bucket they belong to (both share the
    // windows). Per-user and indexed, so this stays cheap.
    await prisma.pushRingEvent.deleteMany({
      where: { userId, createdAt: { lt: since60Min } },
    });
    return { allowed: true };
  } catch (err) {
    console.warn(`[PUSH] Rate-limit check failed for ${userId} (${bucket}) — failing open:`, err);
    return { allowed: true };
  }
}
