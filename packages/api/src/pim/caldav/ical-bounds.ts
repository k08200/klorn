/**
 * Bounds on reading one CalDAV listing's iCalendar (step C3, review fix
 * 2026-10-02). Anyone can put an object in a calendar with an invitation, and the
 * expansion is synchronous CPU work on the API process: measured before these
 * bounds, 20 000 VEVENTs with COUNT=100000 rules held the event loop 18 s, one
 * VEVENT with 200 000 RDATEs 18.6 s (ical.js inserts each into a sorted array),
 * 30 000 overrides of a DAILY series 2 s.
 *
 *   - Caps (CALDAV_MAX_PER_OBJECT, CALDAV_MAX_PER_LISTING) on VEVENTs, overrides
 *     (VEVENTs with a RECURRENCE-ID), RDATE values and EXDATE values, counted on
 *     the parsed text before any of it is expanded. An object over a cap of its
 *     own, or one that would take the listing over a listing cap, is skipped
 *     whole: the listing is truncated (so the sync removes no row) and one
 *     warning per listing names the caps that were hit.
 *   - A parse budget (CALDAV_PARSE_BUDGET_MS): the wall-clock time a listing may
 *     spend working, checked before each object and on each step of a series'
 *     walk. Time spent waiting for a turn of the event loop is not counted, so a
 *     busy process does not cut listings short. Running out truncates the listing.
 *   - Slices (CALDAV_PARSE_SLICE_MS): after that much work the listing yields to
 *     the event loop (setImmediate), so even a legitimate large calendar holds the
 *     process for one slice plus one step at a time (a step's search is bounded
 *     by ical-recur-guard.ts).
 */

import { newRecurSpinBudget, type RecurSpinBudget } from "./ical-recur-guard.js";
import type { IcalComponent } from "./ical-time.js";

/** Working time one listing may spend expanding its objects. */
export const CALDAV_PARSE_BUDGET_MS = 2_000;
/** Working time between two turns given to the event loop. */
export const CALDAV_PARSE_SLICE_MS = 10;

export type IcalCapKind = "vevents" | "overrides" | "rdates" | "exdates";
export type IcalCounts = Readonly<Record<IcalCapKind, number>>;

/**
 * The most one calendar object may carry. A meeting series edited 500 times, or
 * a thousand dates, is far past what a person writes; each RDATE costs ical.js a
 * sorted insert and each EXDATE an instant, so 1 000 is a few milliseconds.
 */
export const CALDAV_MAX_PER_OBJECT: IcalCounts = {
  vevents: 1_000,
  overrides: 500,
  rdates: 1_000,
  exdates: 1_000,
};

/** The most one listing (every calendar of an account, one window) may read. */
export const CALDAV_MAX_PER_LISTING: IcalCounts = {
  vevents: 5_000,
  overrides: 2_500,
  rdates: 5_000,
  exdates: 5_000,
};

const KINDS: readonly IcalCapKind[] = ["vevents", "overrides", "rdates", "exdates"];
const NONE: IcalCounts = { vevents: 0, overrides: 0, rdates: 0, exdates: 0 };
/** A jCal property is [name, parameters, type, ...values]. */
const JCAL_VALUES_FROM = 3;

/** What one parsed object carries, read from its jCal (no value is decoded). */
export function countsOf(root: IcalComponent): IcalCounts {
  const counts: Record<IcalCapKind, number> = { ...NONE };
  for (const component of root.jCal[2] as unknown[][]) {
    if (component[0] !== "vevent") continue;
    counts.vevents += 1;
    for (const property of component[1] as unknown[][]) {
      const values = property.length - JCAL_VALUES_FROM;
      if (property[0] === "recurrence-id") counts.overrides += 1;
      else if (property[0] === "rdate") counts.rdates += values;
      else if (property[0] === "exdate") counts.exdates += values;
    }
  }
  return counts;
}

/** What a listing has admitted so far, and which caps turned objects away. */
export class IcalCapTally {
  private used: IcalCounts = NONE;
  private readonly hits = new Map<string, number>();

  /** True when the object fits every cap, which then counts it; false skips it. */
  admit(counts: IcalCounts): boolean {
    const overObject = KINDS.find((kind) => counts[kind] > CALDAV_MAX_PER_OBJECT[kind]);
    const overListing = KINDS.find(
      (kind) => this.used[kind] + counts[kind] > CALDAV_MAX_PER_LISTING[kind],
    );
    const hit = overObject
      ? `${overObject}-per-object`
      : overListing && `${overListing}-per-listing`;
    if (hit) {
      this.hits.set(hit, (this.hits.get(hit) ?? 0) + 1);
      return false;
    }
    this.used = Object.fromEntries(
      KINDS.map((kind) => [kind, this.used[kind] + counts[kind]]),
    ) as IcalCounts;
    return true;
  }

  /** One line for the whole listing, or nothing when no cap was hit. */
  warnOnce(): void {
    if (this.hits.size === 0) return;
    const caps = [...this.hits].map(([cap, n]) => `${cap}=${n}`).join(" ");
    console.warn(`[CALDAV] objects skipped over a bound (listing truncated, rows kept): ${caps}`);
  }
}

export interface ParseOptions {
  /** The clock the budget is measured on, in ms (tests). Default `performance.now`. */
  readonly now?: () => number;
  /** The budget in ms (tests). Default CALDAV_PARSE_BUDGET_MS. */
  readonly budgetMs?: number;
}

/** One listing's budgets: working time, ical.js search passes, caps. */
export class ParseRun {
  readonly spins: RecurSpinBudget = newRecurSpinBudget();
  readonly caps = new IcalCapTally();
  private readonly now: () => number;
  private readonly budgetMs: number;
  private usedMs = 0;
  private sliceStart: number;

  constructor(options: ParseOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.budgetMs = options.budgetMs ?? CALDAV_PARSE_BUDGET_MS;
    this.sliceStart = this.now();
  }

  /** True once the listing has worked for its whole budget. */
  spent(): boolean {
    return this.usedMs + (this.now() - this.sliceStart) >= this.budgetMs;
  }

  /** True when the current slice is over and the event loop should get a turn. */
  sliceOver(): boolean {
    return this.now() - this.sliceStart >= CALDAV_PARSE_SLICE_MS;
  }

  /** Give the event loop a turn; the wait is not counted against the budget. */
  async yieldTurn(): Promise<void> {
    this.usedMs += this.now() - this.sliceStart;
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.sliceStart = this.now();
  }
}

/**
 * True when some instant of `sorted` (ascending) is within `radius` of `ms`: a
 * binary search for the first instant at or after `ms - radius`. Replaces a scan
 * of every override on every step of a series (30 000 overrides: 2 s).
 */
export function hasInstantNear(sorted: readonly number[], ms: number, radius: number): boolean {
  const from = ms - radius;
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle] as number) < from) low = middle + 1;
    else high = middle;
  }
  return low < sorted.length && (sorted[low] as number) <= ms + radius;
}
