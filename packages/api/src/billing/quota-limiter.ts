/**
 * Per-user LLM call limiter — protects upstream providers from runaway loops
 * AND protects the user's foreground chat from being starved by their own
 * background workers.
 *
 * Two windows are enforced per user:
 *   1. RPM   — sliding 60 s window, capped at LLM_USER_RPM. Shared between
 *              foreground and background calls — it's an upstream protection,
 *              not a budget allocation.
 *   2. Daily — calendar day (UTC). Split into two independent buckets so
 *              background work can never consume the entire daily cap:
 *                - "foreground" (user-initiated chat): LLM_USER_FOREGROUND_DAILY_CAP
 *                - "background" (autonomous-agent, classify, briefing, ...):
 *                  LLM_USER_BACKGROUND_DAILY_CAP
 *              Each bucket has its own counter; foreground keeps working even
 *              after background hits its cap, which is the entire point.
 *
 * The limiter is intentionally in-process: it is a safety net against bursts
 * and a fairness guarantee, not a billing source of truth. The real budget
 * ledger lives in TokenUsage (DB) and cost-guard.ts.
 */

import {
  LLM_USER_BACKGROUND_DAILY_CAP,
  LLM_USER_FOREGROUND_DAILY_CAP,
  LLM_USER_RPM,
} from "../config.js";
import { nextDailyResetMs } from "../llm/model-fallback.js";

export type CallPriority = "foreground" | "background";

interface UserWindow {
  /** Timestamps of recent calls (any priority) for the RPM window */
  recent: number[];
  /** Calls within the current UTC day, per bucket */
  daily: { foreground: number; background: number };
  /** Epoch ms at which the daily counters reset to 0 */
  dailyResetAt: number;
}

const windows = new Map<string, UserWindow>();

const RPM_WINDOW_MS = 60_000;

function dailyCap(priority: CallPriority): number {
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
    w.daily.foreground = 0;
    w.daily.background = 0;
    w.dailyResetAt = nextDailyResetMs(new Date(now));
  }
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
  constructor(reason: "rpm" | "daily", retryAfterMs: number, priority: CallPriority) {
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    const bucket = priority === "foreground" ? "chat" : "background";
    super(
      reason === "rpm"
        ? `You're sending requests too fast. Try again in ${seconds}s.`
        : `You've hit today's AI ${bucket} limit. Resets at UTC midnight (${seconds}s).`,
    );
    this.name = "UserRateLimitedError";
    this.retryAfterMs = retryAfterMs;
    this.reason = reason;
    this.priority = priority;
  }
}

/**
 * Throws if the user is over either window for this priority. Otherwise
 * records this call and returns silently. Default priority is "foreground"
 * — callers that come from background workers (autonomous-agent, briefing,
 * email classifier, etc.) MUST pass "background" so they can't starve chat.
 */
export function checkAndRecordUserCall(
  userId: string,
  options: { cost?: number; priority?: CallPriority } = {},
): void {
  const cost = options.cost ?? 1;
  const priority = options.priority ?? "foreground";
  const now = Date.now();
  const w = getWindow(userId, now);

  if (w.recent.length + cost > LLM_USER_RPM) {
    const oldestRelevant = w.recent[Math.max(0, w.recent.length - LLM_USER_RPM)];
    const retryAfter = Math.max(0, oldestRelevant + RPM_WINDOW_MS - now);
    throw new UserRateLimitedError("rpm", retryAfter, priority);
  }
  const cap = dailyCap(priority);
  if (w.daily[priority] + cost > cap) {
    throw new UserRateLimitedError("daily", Math.max(0, w.dailyResetAt - now), priority);
  }

  for (let i = 0; i < cost; i++) w.recent.push(now);
  w.daily[priority] += cost;
}

export interface UserUsageSnapshot {
  rpmUsed: number;
  rpmCap: number;
  /** Sum of both buckets — kept for clients still reading the unified total. */
  dailyUsed: number;
  /** Sum of both buckets — kept for clients still reading the unified total. */
  dailyCap: number;
  foregroundDailyUsed: number;
  foregroundDailyCap: number;
  backgroundDailyUsed: number;
  backgroundDailyCap: number;
  dailyResetAt: Date;
}

export function getUserUsage(userId: string): UserUsageSnapshot {
  const w = getWindow(userId, Date.now());
  const foregroundCap = LLM_USER_FOREGROUND_DAILY_CAP;
  const backgroundCap = LLM_USER_BACKGROUND_DAILY_CAP;
  return {
    rpmUsed: w.recent.length,
    rpmCap: LLM_USER_RPM,
    dailyUsed: w.daily.foreground + w.daily.background,
    dailyCap: foregroundCap + backgroundCap,
    foregroundDailyUsed: w.daily.foreground,
    foregroundDailyCap: foregroundCap,
    backgroundDailyUsed: w.daily.background,
    backgroundDailyCap: backgroundCap,
    dailyResetAt: new Date(w.dailyResetAt),
  };
}

/** Test/admin helper: drop all in-memory windows */
export function _resetAllUserWindowsForTests(): void {
  windows.clear();
}
