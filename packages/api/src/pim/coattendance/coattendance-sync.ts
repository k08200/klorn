/**
 * The co-attendance pass for one user, behind CALENDAR_COATTENDANCE_ENABLED. Off:
 * it returns before any listing, read or write. Only the scheduler's queue runs it
 * (coattendance-job.ts), never a request and never inside a user's per-tick budget.
 *
 * Each finished UTC day is evaluated exactly once, all of the user's Google
 * calendars together (coattendance-sources.ts holds the watermark and per-source
 * coverage):
 *   1. The days to evaluate run from the day after the watermark through
 *      yesterday (UTC). The first pass starts at the window's first day (today − 30
 *      days). If the watermark is older than the day before the window, the days
 *      in between were never covered: coverage restarts there (the gap rule).
 *   2. Every connectable Google calendar source (the primary, and each GOOGLE
 *      linked calendar not awaiting a re-link when linked sync is on) lists those
 *      days. A source that lists only part (its page cap) is fully listed through
 *      the day before its last listed start; a failed or timed-out listing covers
 *      nothing. The watermark advances only through the last day EVERY source
 *      listed in full.
 *   3. The meetings that ended on those days, from all sources, are merged (one
 *      meeting in two calendars is one), counted by the rules
 *      (coattendance-rules.ts) and written one UTC end-day per transaction
 *      (coattendance-store.ts), or, for a day over a cap, its balanced slices. Each
 *      day transaction re-reads the day's markers under a per-user lock: a
 *      one-slice day that already has one is complete and skipped; a split day is
 *      resumed, writing only its unmarked meetings.
 *   4. The watermark advances (compare-and-swap; a pass that loses it stops);
 *      covered sources get their observed-since day (if
 *      new: the first day of this advance); sources left out lose observed-since.
 *      A source's pass time (coAttendanceLastPassAt) is written on every pass in
 *      which its own listing succeeded in full, advanced or not, and never for a
 *      failed or cut listing: readers use it as a freshness guard.
 * A day at or before the watermark is never evaluated again: a late accept or
 * guest change is ignored (recall loss, by design: a meeting written on its own
 * would show its guest list in the rows that share its transaction).
 *
 * A failed pass advances nothing (the sources that listed in full still get their
 * pass time) and backs off in memory for
 * COATTENDANCE_FAILURE_BACKOFF_MS; it is reported once per user until a pass
 * succeeds. Attendee addresses exist only in memory; logs carry counts, error
 * classes, codes and statuses, never a message. Never throws.
 */

import { calendarCoattendanceEnabled } from "../../config.js";
import { isDataWipeFenceError } from "../../privacy/data-wipe-fence.js";
import { captureError } from "../../sentry.js";
import { withTimeout } from "../../with-timeout.js";
import { connectLinkedCalendars, connectPrimaryCalendar } from "../calendar-providers/dispatch.js";
import type {
  CalendarSession,
  MeetingListing,
  ProviderMeeting,
} from "../calendar-providers/types.js";
import { type CountedMeeting, countMeeting, utcDayOf } from "./coattendance-rules.js";
import {
  type CoverageSource,
  isPassDue,
  readCoverage,
  recordAdvance,
  recordListedOnly,
  restartCoverage,
} from "./coattendance-sources.js";
import {
  eventKeyOf,
  loadOwnAddresses,
  pruneCountedMeetings,
  type RecordResult,
  recordCountedMeetings,
} from "./coattendance-store.js";

export const COATTENDANCE_LOOKBACK_DAYS = 30;
export const COATTENDANCE_PASS_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const COATTENDANCE_FAILURE_BACKOFF_MS = 30 * 60 * 1000;
/** One source's listing: up to 4 pages of 10 s each. */
export const COATTENDANCE_LIST_TIMEOUT_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Google ignores milliseconds and filters on end > timeMin: one second before the first day. */
const ONE_SECOND_MS = 1000;
/** Users whose failure backoff or report is remembered; the oldest is forgotten past the cap. */
const MAX_REMEMBERED_USERS = 10_000;

export interface CoAttendancePassResult extends RecordResult {
  /** The days this pass evaluated: none, or from..through (UTC days). */
  readonly evaluatedFrom: Date | null;
  readonly evaluatedThrough: Date | null;
}

export interface CoAttendanceOptions {
  /** Linked calendars too: LINKED_CALENDAR_SYNC_ENABLED and the user's entitlement. */
  readonly includeLinked: boolean;
}

const retryAfter = new Map<string, number>();
const reported = new Set<string>();
const inFlight = new Set<string>();

export function _resetCoAttendancePassesForTests(): void {
  retryAfter.clear();
  reported.clear();
  inFlight.clear();
}

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  if (map.size >= MAX_REMEMBERED_USERS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** What a failure may say: its class, a code and an HTTP status, never its message. */
function failureLabel(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const { code, response } = (err ?? {}) as { code?: unknown; response?: { status?: unknown } };
  const parts = [name];
  if (typeof code === "string" || typeof code === "number") parts.push(`code=${code}`);
  if (typeof response?.status === "number") parts.push(`status=${response.status}`);
  return parts.join(" ");
}

const addDays = (day: Date, n: number) => new Date(day.getTime() + n * DAY_MS);
const minDay = (a: Date, b: Date) => (a.getTime() <= b.getTime() ? a : b);

interface Connected {
  readonly source: CoverageSource;
  readonly session: CalendarSession;
}

/** Sessions for the sources this pass covers; the rest are left out of it. */
async function connectSources(
  userId: string,
  sources: readonly CoverageSource[],
  options: CoAttendanceOptions,
): Promise<Connected[]> {
  const connected: Connected[] = [];
  const primary = sources.find((s) => s.kind === "primary");
  if (primary) {
    const session = await connectPrimaryCalendar(userId);
    if (session) connected.push({ source: primary, session });
  }
  const linked = options.includeLinked
    ? sources.filter((s) => s.kind === "linked" && !s.needsReconnect)
    : [];
  if (linked.length > 0) {
    const sessions = await connectLinkedCalendars(userId, { skipNeedsReconnect: true });
    for (const source of linked) {
      const found = sessions.find((s) => s.id === source.id && s.session.provider === "GOOGLE");
      if (found) connected.push({ source, session: found.session });
    }
  }
  return connected.filter(({ session }) => session.listMeetingAttendees !== undefined);
}

/** The last day a listing covered in full: yesterday, or (cut) the day before its last start. */
function fullyListedThrough(listing: MeetingListing, from: Date, yesterday: Date): Date {
  if (!listing.truncated) return yesterday;
  if (!listing.lastStart) return addDays(from, -1);
  return minDay(yesterday, addDays(utcDayOf(listing.lastStart), -1));
}

interface Listed {
  /** Every source whose listing succeeded, cut or not. */
  readonly covered: Connected[];
  /** Of those, the ones not cut: listed in full through yesterday. */
  readonly complete: Connected[];
  readonly meetings: ProviderMeeting[];
  /** The last day every source listed in full; before `from` when one failed. */
  readonly through: Date;
  readonly failure: unknown;
}

async function listAll(
  connected: readonly Connected[],
  from: Date,
  today: Date,
  timeoutMs: number,
): Promise<Listed> {
  const window = {
    timeMin: new Date(from.getTime() - ONE_SECOND_MS).toISOString(),
    timeMax: today.toISOString(),
  };
  const yesterday = addDays(today, -1);
  const covered: Connected[] = [];
  const complete: Connected[] = [];
  const meetings: ProviderMeeting[] = [];
  let through = yesterday;
  let failure: unknown = null;
  for (const entry of connected) {
    try {
      const list = entry.session.listMeetingAttendees?.bind(entry.session);
      if (!list) continue;
      const listing = await withTimeout(list(window), timeoutMs, "coattendance.list");
      covered.push(entry);
      if (!listing.truncated) complete.push(entry);
      meetings.push(...listing.meetings);
      through = minDay(through, fullyListedThrough(listing, from, yesterday));
    } catch (err) {
      failure ??= err;
      through = addDays(from, -1);
    }
  }
  return { covered, complete, meetings, through, failure };
}

/** The meetings that ended on [from, through], merged across sources and counted by the rules. */
async function countable(
  userId: string,
  meetings: readonly ProviderMeeting[],
  from: Date,
  through: Date,
  now: Date,
): Promise<CountedMeeting[]> {
  const inRange = meetings.filter((m) => {
    if (!m.endTime) return false;
    const day = utcDayOf(m.endTime).getTime();
    return day >= from.getTime() && day <= through.getTime();
  });
  if (inRange.length === 0) return [];
  const own = await loadOwnAddresses(userId);
  const unique = new Map<string, CountedMeeting>();
  for (const meeting of inRange) {
    const counted = countMeeting(meeting, own, now);
    if (counted) unique.set(eventKeyOf(counted.identity), counted);
  }
  return [...unique.values()];
}

async function pass(
  userId: string,
  options: CoAttendanceOptions,
  now: Date,
  listTimeoutMs: number,
): Promise<CoAttendancePassResult | null> {
  const today = utcDayOf(now);
  const yesterday = addDays(today, -1);
  const windowStart = addDays(today, -COATTENDANCE_LOOKBACK_DAYS);
  const coverage = await readCoverage(userId);
  let sources = coverage.sources;
  let previous = coverage.countedThrough;
  if (previous && previous.getTime() < addDays(windowStart, -1).getTime()) {
    // The gap rule: days between the watermark and the window were never covered.
    previous = addDays(windowStart, -1);
    await restartCoverage(userId, previous, sources);
    sources = sources.map((s) => ({ ...s, observedSince: null }));
  }
  const from = previous ? addDays(previous, 1) : windowStart;
  if (from.getTime() > yesterday.getTime()) return null;
  const candidates = sources.filter(
    (s) => s.kind === "primary" || (options.includeLinked && !s.needsReconnect),
  );
  if (!candidates.some((s) => isPassDue(s, now, COATTENDANCE_PASS_INTERVAL_MS))) return null;

  const connected = await connectSources(userId, sources, options);
  if (connected.length === 0) return null;
  const listed = await listAll(connected, from, today, listTimeoutMs);
  const completeSources = listed.complete.map((c) => c.source);
  if (listed.failure !== null) {
    // The sources that did list in full keep a fresh pass time; nothing advances.
    await recordListedOnly(completeSources, now);
    throw listed.failure;
  }

  let recorded: RecordResult = { meetings: 0, contacts: 0 };
  const coveredSources = listed.covered.map((c) => c.source);
  if (listed.through.getTime() < from.getTime()) {
    await recordListedOnly(completeSources, now);
    return { ...recorded, evaluatedFrom: null, evaluatedThrough: null };
  }
  const meetings = await countable(userId, listed.meetings, from, listed.through, now);
  recorded = await recordCountedMeetings("GOOGLE", userId, meetings);
  const coveredIds = new Set(coveredSources.map((s) => s.id));
  const advanced = await recordAdvance(userId, {
    previous,
    through: listed.through,
    from,
    covered: coveredSources,
    complete: completeSources,
    dropped: sources.filter((s) => !coveredIds.has(s.id)),
    now,
  });
  if (!advanced) {
    // Another process moved the watermark first: it owns these days; stop here.
    console.warn(`[CALENDAR] co-attendance pass for ${userId} lost the watermark race`);
    return null;
  }
  await pruneCountedMeetings(userId, addDays(windowStart, -1));
  return { ...recorded, evaluatedFrom: from, evaluatedThrough: listed.through };
}

/**
 * Count the finished days of one user's Google calendars not evaluated yet. Null
 * when nothing ran: the flag is off, there is nothing new to evaluate, no source
 * is due, the user is backing off after a failure or already running, or the pass
 * failed (reported, never thrown).
 */
export async function runCoAttendancePass(
  userId: string,
  options: CoAttendanceOptions,
  now: Date = new Date(),
  limits: { readonly listTimeoutMs?: number } = {},
): Promise<CoAttendancePassResult | null> {
  if (!calendarCoattendanceEnabled()) return null;
  const until = retryAfter.get(userId);
  if ((until !== undefined && now.getTime() < until) || inFlight.has(userId)) return null;
  inFlight.add(userId);
  try {
    const result = await pass(
      userId,
      options,
      now,
      limits.listTimeoutMs ?? COATTENDANCE_LIST_TIMEOUT_MS,
    );
    retryAfter.delete(userId);
    if (result) reported.delete(userId);
    if (result && result.meetings > 0) {
      console.log(
        `[CALENDAR] co-attendance ${userId} meetings=${result.meetings} contacts=${result.contacts}`,
      );
    }
    return result;
  } catch (err) {
    remember(retryAfter, userId, now.getTime() + COATTENDANCE_FAILURE_BACKOFF_MS);
    // The account's data is being wiped: the refusal is the fence working.
    if (isDataWipeFenceError(err)) return null;
    const label = failureLabel(err);
    console.warn(`[CALENDAR] co-attendance pass failed for ${userId}: ${label}`);
    if (!reported.has(userId)) {
      if (reported.size >= MAX_REMEMBERED_USERS) reported.clear();
      reported.add(userId);
      captureError(new Error(`calendar co-attendance pass failed: ${label}`), {
        tags: { scope: "calendar.coattendance" },
        extra: { userId },
      });
    }
    return null;
  } finally {
    inFlight.delete(userId);
  }
}
