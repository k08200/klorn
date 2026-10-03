/**
 * Bounds on ical.js's recurrence iterator (step C3, review finding 2026-10-01).
 *
 * `RecurIterator.next()` searches for the next occurrence in a loop that, for
 * SECONDLY to WEEKLY rules, ends only when the rule's restrictions match. A rule
 * that can never match (`FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30`) never returns, and
 * the code is synchronous: one calendar object, which anyone can put in a calendar
 * with an invitation, would hang the API process. ical.js 2.2.1 bounds only its
 * MONTHLY and YEARLY searches (336 and 28 misses).
 *
 * The guard: every pass of that search calls `check_contracting_rules`, so it is
 * wrapped to count passes, per `next()` call (MAX_RECUR_SPINS_PER_STEP) and per
 * listing (MAX_RECUR_SPINS_PER_LISTING, the RecurSpinBudget each ical.js call of a
 * listing runs under, `withRecurSpinBudget`), and to throw RecurSpinLimitError past
 * either. The caller counts the object unreadable. Refused up front
 * (`assertBoundedRecurrence`): a huge INTERVAL, which makes a single step take
 * forever in date arithmetic before any pass, and more than MAX_RRULES_PER_EVENT
 * RRULEs (RFC 5545: SHOULD NOT occur more than once), since ical.js scans every
 * rule's iterator on every step (10 000 rules in a 340 KB object blocked the event
 * loop for 6.5 s). A rule without COUNT or UNTIL, or a MINUTELY or SECONDLY one, is
 * bounded by the caller's step caps and parse budget (ical-events.ts,
 * ical-bounds.ts). A BYxxx list needs no bound here: ical.js 2.2.1 refuses an
 * out-of-range value and keeps each list's distinct values only (BYDAY at most
 * 1 134 spellings, the others at most 732), whatever the text's length (pinned by
 * a test).
 *
 * MAX_RECUR_SPINS_PER_STEP (review finding 2026-10-02): 50 000 passes let one
 * impossible rule cost ~60 ms, and 60 such objects 1.9 s of a 2 M listing budget.
 * The longest wait a sane DAILY rule has between two matches is Feb 29 on a given
 * weekday: every 28 years between 1901 and 2099, 10 227 days, one pass each. 12 000
 * fits that and caps an impossible rule at ~11 ms (measured: 60 such objects in
 * 660 ms, against 1.9 s at 50 000). A
 * rule that needs more passes per occurrence (an HOURLY or finer rule matching
 * once in years) is unreadable, which only keeps rows (no removal).
 *
 * This patches the library's prototype, process-wide, once, and only when a CalDAV
 * listing first runs (`ensureRecurSpinGuard`, called by `withRecurSpinBudget`):
 * importing this module changes nothing, so the API process is untouched while
 * CALDAV_CALENDAR_ENABLED is off. Only the CalDAV connector uses ical.js. The
 * version is pinned in package.json, and installing refuses (throws) if the two
 * methods it wraps are gone; the hostile-rule tests fail if it stops working.
 */

import ICAL from "ical.js";

/** Search passes one occurrence may take: Feb 29 on a Monday (28 years of days) fits. */
export const MAX_RECUR_SPINS_PER_STEP = 12_000;
/** Search passes one listing may take, across every series: 100 impossible rules. */
export const MAX_RECUR_SPINS_PER_LISTING = 100 * MAX_RECUR_SPINS_PER_STEP;
/** The largest INTERVAL read (every 1000 days, weeks, months or years). */
export const MAX_RRULE_INTERVAL = 1_000;
/** The most RRULE properties one VEVENT may carry (RFC 5545 expects one). */
export const MAX_RRULES_PER_EVENT = 10;

export class RecurSpinLimitError extends Error {
  constructor() {
    super("recurrence rule exceeded its search bound");
    this.name = "RecurSpinLimitError";
  }
}

interface GuardedIterator {
  klornSpins?: number;
}

type Method = (this: GuardedIterator, ...args: unknown[]) => unknown;

/** The search passes one listing has left. */
export interface RecurSpinBudget {
  spinsLeft: number;
}

export function newRecurSpinBudget(): RecurSpinBudget {
  return { spinsLeft: MAX_RECUR_SPINS_PER_LISTING };
}

/** The budget of the ical.js call in progress; null outside one (the guard is then per step only). */
let active: RecurSpinBudget | null = null;
let installed = false;

export function isRecurSpinGuardInstalled(): boolean {
  return installed;
}

/** Patch ical.js's RecurIterator, once; later calls do nothing. */
export function ensureRecurSpinGuard(): void {
  if (installed) return;
  const proto = ICAL.RecurIterator.prototype as unknown as Record<string, Method | undefined>;
  const next = proto.next;
  const check = proto.check_contracting_rules;
  if (typeof next !== "function" || typeof check !== "function") {
    throw new Error("ical.js RecurIterator changed: the recurrence guard cannot be installed");
  }
  proto.next = function guardedNext(this: GuardedIterator, ...args: unknown[]) {
    this.klornSpins = 0;
    return next.apply(this, args);
  };
  proto.check_contracting_rules = function guardedCheck(this: GuardedIterator) {
    this.klornSpins = (this.klornSpins ?? 0) + 1;
    if (active) active.spinsLeft -= 1;
    if (this.klornSpins > MAX_RECUR_SPINS_PER_STEP || (active !== null && active.spinsLeft < 0)) {
      throw new RecurSpinLimitError();
    }
    return check.call(this);
  };
  installed = true;
}

/**
 * Run `work` (synchronous ical.js recurrence work) against `budget`, with the guard
 * installed. The budget is set only for the call, so listings that interleave
 * across awaits never spend each other's.
 */
export function withRecurSpinBudget<T>(budget: RecurSpinBudget, work: () => T): T {
  ensureRecurSpinGuard();
  const outer = active;
  active = budget;
  try {
    return work();
  } finally {
    active = outer;
  }
}

/** Throws RecurSpinLimitError for too many RRULEs, or one whose INTERVAL is past the bound. */
export function assertBoundedRecurrence(component: InstanceType<typeof ICAL.Component>): void {
  const rules = component.getAllProperties("rrule");
  if (rules.length > MAX_RRULES_PER_EVENT) throw new RecurSpinLimitError();
  for (const value of rules.map((prop) => prop.getFirstValue())) {
    const interval = (value as { interval?: unknown } | null)?.interval;
    if (typeof interval === "number" && interval > MAX_RRULE_INTERVAL) {
      throw new RecurSpinLimitError();
    }
  }
}
