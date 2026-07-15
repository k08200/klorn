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
  LLM_BACKGROUND_RPM_MAX_WAIT_MS,
  LLM_RPM_FOREGROUND_RESERVE,
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

/**
 * RPM admission limit per priority. The window itself is shared (upstream
 * protection), but background may never consume the last
 * LLM_RPM_FOREGROUND_RESERVE slots — so a mail-sync burst queueing through
 * awaitUserCallSlot leaves chat headroom instead of starving it.
 */
export function rpmCeilingFor(priority: CallPriority): number {
  if (priority === "foreground") return LLM_USER_RPM;
  return Math.max(1, LLM_USER_RPM - LLM_RPM_FOREGROUND_RESERVE);
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

  const rpmLimit = rpmCeilingFor(priority);
  if (w.recent.length + cost > rpmLimit) {
    const oldestRelevant = w.recent[Math.max(0, w.recent.length - rpmLimit)];
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

// Small random delay added to each re-check so a burst of parked waiters
// doesn't wake and re-contend on the exact same tick.
const SLOT_RETRY_JITTER_MAX_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AwaitSlotOptions {
  cost?: number;
  priority?: CallPriority;
  /**
   * Max total time a background call may wait for an RPM slot.
   * Defaults to LLM_BACKGROUND_RPM_MAX_WAIT_MS; 0 means fail fast.
   */
  maxWaitMs?: number;
}

/**
 * Like checkAndRecordUserCall, but a BACKGROUND call over the RPM window
 * parks until a slot frees (bounded by maxWaitMs) instead of failing.
 *
 * Why: the classify/summarize burst after a mail sync is legitimate work with
 * no user staring at a spinner — failing it instantly demoted every email past
 * slot LLM_USER_RPM to the keyword fallback, which is PERMANENT (a
 * fallback-judged email gets an AttentionItem, so the backfill sweep never
 * re-judges it). Measured on prod 2026-07-15: 34 of 58 emails in one sync
 * burst fell back, PUSH count 0. Waiting turns the burst into an ordered
 * drain at the background ceiling (see rpmCeilingFor).
 *
 * Foreground calls never wait — chat must fail fast with a clear retry-after.
 * Daily-cap exhaustion also fails fast at any priority: no wait shorter than
 * "until UTC midnight" can help, and parking promises for hours would leak.
 */
export async function awaitUserCallSlot(
  userId: string,
  options: AwaitSlotOptions = {},
): Promise<void> {
  const priority = options.priority ?? "foreground";
  const maxWaitMs = options.maxWaitMs ?? LLM_BACKGROUND_RPM_MAX_WAIT_MS;
  if (priority === "foreground" || maxWaitMs <= 0) {
    checkAndRecordUserCall(userId, options);
    return;
  }
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      checkAndRecordUserCall(userId, options);
      return;
    } catch (err) {
      if (!(err instanceof UserRateLimitedError) || err.reason !== "rpm") throw err;
      const now = Date.now();
      // If even the next free slot lands past the deadline, give up now —
      // the caller's fallback path is better than a wait that can't succeed.
      if (now + err.retryAfterMs > deadline) throw err;
      await sleep(err.retryAfterMs + Math.random() * SLOT_RETRY_JITTER_MAX_MS);
    }
  }
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
