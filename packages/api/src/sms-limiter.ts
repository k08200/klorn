/**
 * Per-user daily SMS cap. In-process counter that resets at UTC midnight.
 *
 * SMS is dollars-per-message: a stuck loop can burn real budget in minutes.
 * This limiter is a hard wall in front of the Twilio client so any caller
 * that asks for an SMS over the cap gets a clean "no" instead of paying.
 *
 * Restarts reset the counter — acceptable for admin-MVP scope. If we open
 * SMS to non-admins, this needs to move to a DB-backed counter.
 */

import { nextDailyResetMs } from "./model-fallback.js";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function smsDailyCap(): number {
  return intEnv("SMS_DAILY_CAP_PER_USER", 10);
}

interface UserWindow {
  /** Calls within the current UTC day */
  count: number;
  /** Epoch ms at which the daily counter resets to 0 */
  dailyResetAt: number;
}

const windows = new Map<string, UserWindow>();

function getWindow(userId: string, now: number): UserWindow {
  let w = windows.get(userId);
  if (!w) {
    w = { count: 0, dailyResetAt: nextDailyResetMs(new Date(now)) };
    windows.set(userId, w);
  }
  if (now >= w.dailyResetAt) {
    w.count = 0;
    w.dailyResetAt = nextDailyResetMs(new Date(now));
  }
  return w;
}

/**
 * Returns true if the user is under the daily cap (and records the send),
 * false if the cap has been hit. Caller is responsible for actually sending
 * the SMS when this returns true — the limiter is just an accountant.
 */
export function checkAndRecordSmsSend(userId: string): boolean {
  const cap = smsDailyCap();
  if (cap <= 0) return false; // 0 disables SMS entirely
  const now = Date.now();
  const w = getWindow(userId, now);
  if (w.count >= cap) return false;
  w.count += 1;
  return true;
}

export interface SmsUsageSnapshot {
  used: number;
  cap: number;
  resetAt: Date;
}

export function getSmsUsage(userId: string): SmsUsageSnapshot {
  const cap = smsDailyCap();
  const w = getWindow(userId, Date.now());
  return { used: w.count, cap, resetAt: new Date(w.dailyResetAt) };
}

/** Test/admin helper: drop all in-memory windows. */
export function _resetAllSmsWindowsForTests(): void {
  windows.clear();
}
