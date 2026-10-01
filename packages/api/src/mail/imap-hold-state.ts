/**
 * What this process remembers about held IMAP mailboxes (step B2b of
 * docs/providers/unified-platform-plan.md): when each account last logged and alerted
 * while held, and how long a failed repair waits before it is tried again.
 *
 * In memory on purpose. A restart forgets it, which at worst repeats one log line,
 * one alert and one repair attempt. Every map is bounded (MAX_TRACKED_ACCOUNTS; the
 * oldest entry goes first), so a fleet of held mailboxes cannot grow it without end.
 */

/** A held mailbox logs at most this often per account. */
export const HELD_WARN_INTERVAL_MS = 15 * 60_000;
/** A held mailbox (and a failing repair) alerts Sentry at most this often per account. */
export const HELD_ALERT_INTERVAL_MS = 24 * 60 * 60_000;
/** The wait after the first failed repair; it doubles per consecutive failure. */
export const REPAIR_BACKOFF_BASE_MS = 10 * 60_000;
/** The longest wait between repair attempts. */
export const REPAIR_BACKOFF_MAX_MS = 6 * 60 * 60_000;
/** Accounts each map remembers at most. */
export const MAX_TRACKED_ACCOUNTS = 1000;
/** Doubling stops here; REPAIR_BACKOFF_MAX_MS is reached long before. */
const MAX_BACKOFF_EXPONENT = 30;

/** Set `key` as the newest entry; when the map is full the oldest entry is dropped. */
export function rememberBounded<V>(
  map: Map<string, V>,
  key: string,
  value: V,
  max: number = MAX_TRACKED_ACCOUNTS,
): void {
  map.delete(key);
  if (map.size >= max) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

/** How long to wait after `failures` consecutive failed repairs (1 = the first). */
export function repairBackoffMs(failures: number): number {
  const exponent = Math.min(Math.max(0, failures - 1), MAX_BACKOFF_EXPONENT);
  return Math.min(REPAIR_BACKOFF_BASE_MS * 2 ** exponent, REPAIR_BACKOFF_MAX_MS);
}

const lastWarnAt = new Map<string, number>();
/** Keyed `<kind>:<account id>`. */
const lastAlertAt = new Map<string, number>();
const backoff = new Map<string, { failures: number; retryAt: number }>();

/** True at most once per `intervalMs` per key; a true answer records `now`. */
function due(map: Map<string, number>, key: string, now: Date, intervalMs: number): boolean {
  const last = map.get(key);
  if (last !== undefined && now.getTime() - last < intervalMs) return false;
  rememberBounded(map, key, now.getTime());
  return true;
}

export function heldWarnDue(accountId: string, now: Date): boolean {
  return due(lastWarnAt, accountId, now, HELD_WARN_INTERVAL_MS);
}

export function heldAlertDue(kind: "held" | "repair-failed", accountId: string, now: Date) {
  return due(lastAlertAt, `${kind}:${accountId}`, now, HELD_ALERT_INTERVAL_MS);
}

/** When a failed repair may run again (epoch ms), or null when none failed. */
export function repairRetryAt(accountId: string): number | null {
  return backoff.get(accountId)?.retryAt ?? null;
}

/** Record a failed repair; answers when the next attempt may run (epoch ms). */
export function noteRepairFailure(accountId: string, now: Date): number {
  const failures = (backoff.get(accountId)?.failures ?? 0) + 1;
  const retryAt = now.getTime() + repairBackoffMs(failures);
  rememberBounded(backoff, accountId, { failures, retryAt });
  return retryAt;
}

export function clearRepairBackoff(accountId: string): void {
  backoff.delete(accountId);
}

/** Test hook: forget everything. */
export function resetHoldState(): void {
  lastWarnAt.clear();
  lastAlertAt.clear();
  backoff.clear();
}
