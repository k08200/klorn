/**
 * Per-user LLM call limiter — protects upstream providers from runaway loops.
 *
 * Two windows are enforced per user:
 *   1. RPM   — sliding 60 s window, capped at LLM_USER_RPM
 *   2. Daily — calendar day (UTC), capped at LLM_USER_DAILY_CAP
 *
 * The limiter is intentionally in-process: it is a safety net against bursts,
 * not a billing source of truth. The real budget ledger lives in
 * TokenUsage (DB) and cost-guard.ts.
 *
 * SYSTEM jobs (background workers, schedulers, classification batches) bypass
 * the limiter — they have their own pacing via scheduler intervals.
 */

import { LLM_USER_DAILY_CAP, LLM_USER_RPM } from "./config.js";
import { nextDailyResetMs } from "./model-fallback.js";

interface UserWindow {
  /** Timestamps of recent calls, kept sorted, pruned each check */
  recent: number[];
  /** Count of calls within the current UTC day */
  dailyCount: number;
  /** Epoch ms at which the daily counter resets to 0 */
  dailyResetAt: number;
}

const windows = new Map<string, UserWindow>();

const RPM_WINDOW_MS = 60_000;

function getWindow(userId: string, now: number): UserWindow {
  let w = windows.get(userId);
  if (!w) {
    w = { recent: [], dailyCount: 0, dailyResetAt: nextDailyResetMs(new Date(now)) };
    windows.set(userId, w);
  }
  if (now >= w.dailyResetAt) {
    w.dailyCount = 0;
    w.dailyResetAt = nextDailyResetMs(new Date(now));
  }
  // Drop timestamps older than the RPM window so .length is the live count
  const cutoff = now - RPM_WINDOW_MS;
  while (w.recent.length > 0 && w.recent[0] < cutoff) {
    w.recent.shift();
  }
  return w;
}

export class UserRateLimitedError extends Error {
  retryAfterMs: number;
  reason: "rpm" | "daily";
  constructor(reason: "rpm" | "daily", retryAfterMs: number) {
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    super(
      reason === "rpm"
        ? `You're sending requests too fast. Try again in ${seconds}s.`
        : `You've hit today's AI request limit. Resets at UTC midnight (${seconds}s).`,
    );
    this.name = "UserRateLimitedError";
    this.retryAfterMs = retryAfterMs;
    this.reason = reason;
  }
}

/**
 * Throws if the user is over either window. Otherwise records this call and
 * returns silently. Pass an explicit `cost` of 1 (default) so background loops
 * that issue multiple LLM calls per tick can charge themselves multiple slots.
 */
export function checkAndRecordUserCall(userId: string, cost = 1): void {
  const now = Date.now();
  const w = getWindow(userId, now);

  if (w.recent.length + cost > LLM_USER_RPM) {
    const oldestRelevant = w.recent[Math.max(0, w.recent.length - LLM_USER_RPM)];
    const retryAfter = Math.max(0, oldestRelevant + RPM_WINDOW_MS - now);
    throw new UserRateLimitedError("rpm", retryAfter);
  }
  if (w.dailyCount + cost > LLM_USER_DAILY_CAP) {
    throw new UserRateLimitedError("daily", Math.max(0, w.dailyResetAt - now));
  }

  for (let i = 0; i < cost; i++) w.recent.push(now);
  w.dailyCount += cost;
}

export interface UserUsageSnapshot {
  rpmUsed: number;
  rpmCap: number;
  dailyUsed: number;
  dailyCap: number;
  dailyResetAt: Date;
}

export function getUserUsage(userId: string): UserUsageSnapshot {
  const w = getWindow(userId, Date.now());
  return {
    rpmUsed: w.recent.length,
    rpmCap: LLM_USER_RPM,
    dailyUsed: w.dailyCount,
    dailyCap: LLM_USER_DAILY_CAP,
    dailyResetAt: new Date(w.dailyResetAt),
  };
}

/** Test/admin helper: drop all in-memory windows */
export function _resetAllUserWindowsForTests(): void {
  windows.clear();
}
