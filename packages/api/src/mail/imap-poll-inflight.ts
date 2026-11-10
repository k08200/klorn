/**
 * Which accounts have a poll running, and whether one looks stuck.
 *
 * A tick that finds an account's previous poll still running skips it (the same mailbox
 * is never logged into twice at once, and a stuck account blocks nothing else). That
 * skip used to leave no trace, so an account stuck for good was invisible. This module
 * keeps the guard and decides what the skip should say:
 *   - a warning, at most once per STUCK_POLL_WARN_INTERVAL_MS per account;
 *   - one Sentry report per account per process, once the poll has been running for
 *     STUCK_POLL_REPORT_AFTER_MS (a normal overlap is shorter and is never reported).
 *
 * In-process, like the other poll state. The guard map holds only polls that are running:
 * an entry is added when a poll starts and removed when it ends, so it is bounded by the
 * accounts being polled at once. The set of accounts already reported is capped; past
 * the cap the oldest is forgotten (it simply reports again, which errs towards visibility).
 */

/** The longest a skipped poll goes without a warning for the same account. */
export const STUCK_POLL_WARN_INTERVAL_MS = 30 * 60_000;
/** A poll running this long is no ordinary overlap (a session is cut at 90 s). */
export const STUCK_POLL_REPORT_AFTER_MS = 15 * 60_000;
export const MAX_TRACKED_STUCK_REPORTS = 10_000;

interface RunningPoll {
  startedAt: number;
  /** When a skip of this poll last logged a warning; null before the first. */
  lastWarnedAt: number | null;
}

export interface SkippedPoll {
  /** How long the running poll has been going. */
  ageMs: number;
  /** Log a warning for this skip. */
  warn: boolean;
  /** Report this account to Sentry (first time past the threshold in this process). */
  report: boolean;
}

/** rowId -> the poll running for it. Entries live exactly as long as the poll. */
const running = new Map<string, RunningPoll>();
/** Accounts already reported to Sentry, oldest first. */
const reported = new Set<string>();

/** A poll of this account starts. */
export function beginPoll(rowId: string, now: number = Date.now()): void {
  running.set(rowId, { startedAt: now, lastWarnedAt: null });
}

/** The poll of this account ended, however it ended. */
export function endPoll(rowId: string): void {
  running.delete(rowId);
}

export function isPollInFlight(rowId: string): boolean {
  return running.has(rowId);
}

/** True the first time an account is reported in this process. */
function markReported(rowId: string): boolean {
  if (reported.has(rowId)) return false;
  for (const key of reported) {
    if (reported.size < MAX_TRACKED_STUCK_REPORTS) break;
    reported.delete(key);
  }
  reported.add(rowId);
  return true;
}

/**
 * A tick skipped this account because its poll is running: what should the skip say?
 * Null when no poll is running for it.
 */
export function noteSkippedPoll(rowId: string, now: number = Date.now()): SkippedPoll | null {
  const poll = running.get(rowId);
  if (!poll) return null;
  const ageMs = Math.max(0, now - poll.startedAt);
  const warn = poll.lastWarnedAt === null || now - poll.lastWarnedAt >= STUCK_POLL_WARN_INTERVAL_MS;
  if (warn) running.set(rowId, { ...poll, lastWarnedAt: now });
  const report = ageMs >= STUCK_POLL_REPORT_AFTER_MS && markReported(rowId);
  return { ageMs, warn, report };
}

/** Test hook: how many polls are held. */
export function inFlightPollCount(): number {
  return running.size;
}

/** Test hook. */
export function resetPollInFlightState(): void {
  running.clear();
  reported.clear();
}
