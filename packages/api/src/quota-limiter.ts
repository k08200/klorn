/**
 * Per-user LLM call limiter — protects upstream providers from runaway loops.
 *
 * Two windows are enforced per user:
 *   1. RPM   — sliding 60 s window, capped at LLM_USER_RPM (shared)
 *   2. Daily — calendar day (UTC), split into two independent buckets:
 *                - foreground (chat, user-triggered drafts) capped at
 *                  LLM_USER_FOREGROUND_DAILY_CAP
 *                - background (briefing, classification, autonomous agent,
 *                  attachment analysis, etc.) capped at
 *                  LLM_USER_BACKGROUND_DAILY_CAP
 *
 * The split exists so a runaway background loop cannot exhaust the cap the
 * user's own foreground chat needs.
 *
 * The limiter is intentionally in-process: it is a safety net against bursts,
 * not a billing source of truth. The real budget ledger lives in
 * TokenUsage (DB) and cost-guard.ts.
 *
 * SYSTEM jobs that pass no userId bypass the limiter — they have their own
 * pacing via scheduler intervals.
 */

import {
  LLM_USER_BACKGROUND_DAILY_CAP,
  LLM_USER_FOREGROUND_DAILY_CAP,
  LLM_USER_RPM,
} from "./config.js";
import { nextDailyResetMs } from "./model-fallback.js";

export type CallPriority = "foreground" | "background";

interface UserWindow {
  /** Timestamps of recent calls, kept sorted, pruned each check */
  recent: number[];
  /** Per-priority call counts within the current UTC day */
  daily: { foreground: number; background: number };
  /** Epoch ms at which the daily counters reset to 0 */
  dailyResetAt: number;
}

const windows = new Map<string, UserWindow>();

const RPM_WINDOW_MS = 60_000;

function capFor(priority: CallPriority): number {
  return priority === "foreground" ? LLM_USER_FOREGROUND_DAILY_CAP : LLM_USER_BACKGROUND_DAILY_CAP;
}

function getWindow(userId: string, now: number): UserWindow {
  let w = windows.get(userId);
  if (!w) {
    w = {
      recent: [],
      daily: { foreground: 0, background: 0 },
      dailyResetAt: nextDailyResetMs(new Date(now)),
    };
    windows.set(userId, w);
  }
  if (now >= w.dailyResetAt) {
    w.daily = { foreground: 0, background: 0 };
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
  priority: CallPriority;
  constructor(
    reason: "rpm" | "daily",
    retryAfterMs: number,
    priority: CallPriority = "foreground",
  ) {
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    const bucketLabel = priority === "foreground" ? "chat" : "background";
    super(
      reason === "rpm"
        ? `You're sending requests too fast. Try again in ${seconds}s.`
        : `You've hit today's AI ${bucketLabel} request limit. Resets at UTC midnight (${seconds}s).`,
    );
    this.name = "UserRateLimitedError";
    this.retryAfterMs = retryAfterMs;
    this.reason = reason;
    this.priority = priority;
  }
}

export interface CheckAndRecordOptions {
  /** How many slots this call consumes (default 1) */
  cost?: number;
  /** Which daily bucket to charge (default "foreground") */
  priority?: CallPriority;
}

/**
 * Throws if the user is over the RPM window or the priority's daily bucket.
 * Otherwise records this call and returns silently. Pass an explicit `cost`
 * so background loops that issue multiple LLM calls per tick can charge
 * themselves multiple slots. Pass `priority: "background"` for any caller
 * that is not blocking a live user interaction.
 */
export function checkAndRecordUserCall(userId: string, options: CheckAndRecordOptions = {}): void {
  const cost = options.cost ?? 1;
  const priority: CallPriority = options.priority ?? "foreground";
  const now = Date.now();
  const w = getWindow(userId, now);

  if (w.recent.length + cost > LLM_USER_RPM) {
    const oldestRelevant = w.recent[Math.max(0, w.recent.length - LLM_USER_RPM)];
    const retryAfter = Math.max(0, oldestRelevant + RPM_WINDOW_MS - now);
    throw new UserRateLimitedError("rpm", retryAfter, priority);
  }
  const cap = capFor(priority);
  if (w.daily[priority] + cost > cap) {
    throw new UserRateLimitedError("daily", Math.max(0, w.dailyResetAt - now), priority);
  }

  for (let i = 0; i < cost; i++) w.recent.push(now);
  w.daily[priority] += cost;
}

export interface UserUsageSnapshot {
  rpmUsed: number;
  rpmCap: number;
  /** Sum of foreground + background, kept for back-compat */
  dailyUsed: number;
  /** Sum of foreground + background caps, kept for back-compat */
  dailyCap: number;
  foregroundDailyUsed: number;
  foregroundDailyCap: number;
  backgroundDailyUsed: number;
  backgroundDailyCap: number;
  dailyResetAt: Date;
}

export function getUserUsage(userId: string): UserUsageSnapshot {
  const w = getWindow(userId, Date.now());
  const foregroundUsed = w.daily.foreground;
  const backgroundUsed = w.daily.background;
  return {
    rpmUsed: w.recent.length,
    rpmCap: LLM_USER_RPM,
    dailyUsed: foregroundUsed + backgroundUsed,
    dailyCap: LLM_USER_FOREGROUND_DAILY_CAP + LLM_USER_BACKGROUND_DAILY_CAP,
    foregroundDailyUsed: foregroundUsed,
    foregroundDailyCap: LLM_USER_FOREGROUND_DAILY_CAP,
    backgroundDailyUsed: backgroundUsed,
    backgroundDailyCap: LLM_USER_BACKGROUND_DAILY_CAP,
    dailyResetAt: new Date(w.dailyResetAt),
  };
}

/** Test/admin helper: drop all in-memory windows */
export function _resetAllUserWindowsForTests(): void {
  windows.clear();
}
