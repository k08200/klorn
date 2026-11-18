/**
 * Per-account login throttle, keyed on the normalized email.
 *
 * The per-IP rate limit (10/15min on POST /login) cannot see a distributed
 * brute force that rotates source addresses against a single account. This
 * fixed window (anchored at the first attempt) counts login ATTEMPTS per
 * account regardless of origin and locks the account for the remainder of
 * the window once the threshold is hit; a successful login clears it.
 *
 * Attempts are recorded BEFORE credential verification, in the same
 * synchronous section as the throttle check. The check+record pair never
 * yields to the event loop, so a concurrent wave against one account cannot
 * read a stale count past the threshold (TOCTOU) — at most
 * LOGIN_THROTTLE_MAX_FAILURES guesses enter verification per window.
 *
 * Tradeoffs, deliberately accepted:
 * - In-process (same as notify/sms-limiter.ts): restarts reset the counters,
 *   which only ever fails open. If the API ever runs >1 replica, each
 *   replica tracks its own window, multiplying the effective threshold by
 *   the replica count (single-instance Render deployment today).
 * - Unknown emails are counted too, and the locked response mirrors the
 *   per-IP limiter's, so lockout state never becomes an account-existence
 *   oracle.
 * - Residual lockout-DoS: an attacker who knows a victim's email can still
 *   lock the account by burning 30 attempts. The threshold is intentionally
 *   3x the per-IP limit so a single source address can never trip it alone —
 *   the attack requires 3+ coordinated IPs per 15-minute episode, and every
 *   locked attempt is logged at the route for detection.
 */

import { createAccountWindowThrottle } from "./account-window-throttle.js";

export const LOGIN_THROTTLE_MAX_FAILURES = 30;
export const LOGIN_THROTTLE_WINDOW_MS = 15 * 60 * 1000;

/** Hard ceiling on tracked accounts (account-window-throttle.ts: fails open past it). */
export const LOGIN_THROTTLE_MAX_TRACKED = 50_000;

const throttle = createAccountWindowThrottle({
  maxAttempts: LOGIN_THROTTLE_MAX_FAILURES,
  windowMs: LOGIN_THROTTLE_WINDOW_MS,
  maxTracked: LOGIN_THROTTLE_MAX_TRACKED,
});

/**
 * Milliseconds until the account's current lock expires; 0 when the account
 * is not locked. Never mutates state beyond dropping an expired window.
 */
export function loginThrottleRemainingMs(normalizedEmail: string): number {
  return throttle.remainingMs(normalizedEmail);
}

export function isLoginThrottled(normalizedEmail: string): boolean {
  return loginThrottleRemainingMs(normalizedEmail) > 0;
}

/**
 * Count one login attempt. Call synchronously right after the throttle
 * check, before any await — see the module docstring for why.
 */
export function recordLoginAttempt(normalizedEmail: string): void {
  throttle.record(normalizedEmail);
}

/** A successful login clears the account's window. */
export function clearLoginAttempts(normalizedEmail: string): void {
  throttle.clear(normalizedEmail);
}

/** Test helper: drop all in-memory windows. */
export function _resetLoginThrottleForTests(): void {
  throttle.reset();
}

/** Test helper: current number of tracked windows. */
export function _loginThrottleTrackedCountForTests(): number {
  return throttle.trackedCount();
}
