/**
 * Back a failing CalDAV account off (step C3 review fix, 2026-10-02), the pattern
 * of mail/imap-poll-backoff.ts. A server that stalls or errors (anything but a 401,
 * which flags the account for a re-link instead) used to be tried on every sync
 * tick: up to CALDAV_SYNC_DEADLINE_MS (45 s) of the serial tick per account, every
 * 15 minutes, and the conflict checks waited on it too. Each consecutive failure
 * now doubles the delay before the account is tried again, from one tick up to a
 * cap; a successful listing or a re-link starts over. While backed off, the
 * provider opens no session (pim/calendar-providers/caldav.ts), so neither the
 * sync nor a conflict check sends a request.
 *
 * In-process and per account: a restart forgets it, which only errs towards
 * trying sooner. Memory is bounded; past the cap the oldest account is forgotten
 * (it is simply tried again).
 */

/** One sync tick. */
export const CALDAV_BACKOFF_BASE_MS = 15 * 60_000;
export const CALDAV_BACKOFF_MAX_MS = 6 * 60 * 60_000;
export const MAX_TRACKED_CALDAV_BACKOFFS = 10_000;
/** 2^30 times the base is far past the cap. */
const MAX_EXPONENT = 30;

/** The delay after `consecutiveFailures` failures in a row: base, doubling, capped. */
export function caldavBackoffMs(consecutiveFailures: number): number {
  const failures = Number.isFinite(consecutiveFailures) ? Math.max(1, consecutiveFailures) : 1;
  const exponent = Math.min(failures - 1, MAX_EXPONENT);
  return Math.min(CALDAV_BACKOFF_BASE_MS * 2 ** exponent, CALDAV_BACKOFF_MAX_MS);
}

interface BackoffState {
  readonly failures: number;
  readonly until: number;
}

/** Linked account id -> consecutive failures and when it may be tried again. */
const states = new Map<string, BackoffState>();

export function isCaldavBackedOff(accountId: string, now: number = Date.now()): boolean {
  const state = states.get(accountId);
  return state !== undefined && now < state.until;
}

/** Record a failure that is not a revoked password: returns the delay now in force. */
export function noteCaldavFailure(accountId: string, now: number = Date.now()): number {
  const failures = (states.get(accountId)?.failures ?? 0) + 1;
  const delay = caldavBackoffMs(failures);
  if (!states.has(accountId)) {
    for (const key of states.keys()) {
      if (states.size < MAX_TRACKED_CALDAV_BACKOFFS) break;
      states.delete(key);
    }
  }
  states.set(accountId, { failures, until: now + delay });
  return delay;
}

/** A listing succeeded, or the account was re-linked: start over. */
export function clearCaldavBackoff(accountId: string): void {
  states.delete(accountId);
}

export function _resetCaldavBackoffForTests(): void {
  states.clear();
}
