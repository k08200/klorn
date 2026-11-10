/**
 * Back a failing generic account off (step B4 review fix). A host that stalls or
 * refuses (without rejecting the login, which has its own cooldown and reconnect flag)
 * used to be tried again every five minutes: up to ~105 s of the serial tick each time,
 * and a user can hold three such accounts. Each consecutive failure now doubles the
 * delay before the account is polled again, up to a cap; a successful poll or a relink
 * starts over.
 *
 * In-process and per account, like the other poll state: a restart forgets it, which
 * only errs towards polling sooner. Memory is bounded; past the cap the oldest account
 * is forgotten (it is simply polled again).
 */

export const POLL_BACKOFF_BASE_MS = 10 * 60_000;
export const POLL_BACKOFF_MAX_MS = 6 * 60 * 60_000;
export const MAX_TRACKED_POLL_BACKOFFS = 10_000;

/** The delay after `consecutiveFailures` failures in a row: base, doubling, capped. */
export function pollBackoffMs(consecutiveFailures: number): number {
  const failures = Number.isFinite(consecutiveFailures) ? Math.max(1, consecutiveFailures) : 1;
  const exponent = Math.min(failures - 1, 30); // 2^30 already exceeds the cap by far
  return Math.min(POLL_BACKOFF_BASE_MS * 2 ** exponent, POLL_BACKOFF_MAX_MS);
}

interface BackoffState {
  failures: number;
  until: number;
}

/** rowId -> consecutive failures and when the account may be polled again. */
const states = new Map<string, BackoffState>();

export function isPollBackedOff(rowId: string, now: number = Date.now()): boolean {
  const state = states.get(rowId);
  return state !== undefined && now < state.until;
}

/** Record a failed poll: returns the delay now in force. */
export function notePollBackoff(rowId: string, now: number = Date.now()): number {
  const failures = (states.get(rowId)?.failures ?? 0) + 1;
  const delay = pollBackoffMs(failures);
  if (!states.has(rowId)) {
    for (const key of states.keys()) {
      if (states.size < MAX_TRACKED_POLL_BACKOFFS) break;
      states.delete(key);
    }
  }
  states.set(rowId, { failures, until: now + delay });
  return delay;
}

/** A poll succeeded, or the account was relinked: start over. */
export function clearPollBackoff(rowId: string): void {
  states.delete(rowId);
}

/** Test hook. */
export function resetPollBackoffState(): void {
  states.clear();
}
