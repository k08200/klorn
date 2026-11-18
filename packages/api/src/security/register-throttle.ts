/**
 * Per-address register throttle, keyed on the normalized email.
 *
 * POST /register answers 409 for an address that already has an account and
 * hands a session back at once (no verification step), so it is an
 * account-existence oracle by design; docs/security/account-enumeration.md
 * records why that residual is accepted. The per-IP route limit (5/15min)
 * prices a sweep of many addresses from one source; this window prices
 * hammering one address from many sources, which the per-IP limit cannot see.
 *
 * Attempts are counted after input validation and BEFORE any lookup, in the
 * same synchronous section as the check (login-throttle.ts idiom), and for
 * every address alike, so a locked address answers the same 429 as the per-IP
 * limiter whether or not it has an account. A successful registration does
 * not clear the window: the address is taken from then on.
 *
 * The threshold is twice the per-IP limit, so one person retrying from one
 * network never trips it. Lockout-DoS is not a concern here: whoever could
 * burn an address's attempts could as well register it first.
 */

import { createAccountWindowThrottle } from "./account-window-throttle.js";

export const REGISTER_THROTTLE_MAX_ATTEMPTS = 10;
export const REGISTER_THROTTLE_WINDOW_MS = 15 * 60 * 1000;
export const REGISTER_THROTTLE_MAX_TRACKED = 50_000;

const throttle = createAccountWindowThrottle({
  maxAttempts: REGISTER_THROTTLE_MAX_ATTEMPTS,
  windowMs: REGISTER_THROTTLE_WINDOW_MS,
  maxTracked: REGISTER_THROTTLE_MAX_TRACKED,
});

/** Milliseconds until the address's register lock expires; 0 when it is not locked. */
export function registerThrottleRemainingMs(normalizedEmail: string): number {
  return throttle.remainingMs(normalizedEmail);
}

/** Count one register attempt. Call synchronously right after the check, before any await. */
export function recordRegisterAttempt(normalizedEmail: string): void {
  throttle.record(normalizedEmail);
}

/** Test helper: drop all in-memory windows. */
export function _resetRegisterThrottleForTests(): void {
  throttle.reset();
}
