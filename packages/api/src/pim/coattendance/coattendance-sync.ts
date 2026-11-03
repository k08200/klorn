/**
 * The co-attendance pass for one Google calendar source, behind
 * CALENDAR_COATTENDANCE_ENABLED. Off: it returns before any listing, read or
 * write. Only the scheduler's background job runs it (coattendance-job.ts), never
 * a request and never inside a user's per-tick budget: the first pass after the
 * flag is turned on writes 30 days of meetings.
 *
 * On: for a session that can list attendees (Google, primary and linked), when the
 * source's persisted interval has passed (coattendance-sources.ts), it lists the
 * last COATTENDANCE_LOOKBACK_DAYS (the row sync lists only upcoming events, so
 * ended meetings need a listing of their own), counts each ended meeting once per
 * contact (coattendance-rules.ts, coattendance-store.ts), forgets markers no pass
 * can list again, and records the pass on the source. The window is fixed and the
 * markers make every pass idempotent, so the first pass also counts the 30 days
 * before it, and a missed pass is caught up by the next.
 *
 * A failed pass records nothing on the source, so it does not use the interval: it
 * backs off in memory for COATTENDANCE_FAILURE_BACKOFF_MS and is retried then.
 *
 * Attendee addresses exist only in memory here. Nothing is logged but counts, and
 * a failure is reported by its error class, code and HTTP status only: a database
 * error's message can quote the values of the query that failed. Never throws.
 */

import { calendarCoattendanceEnabled } from "../../config.js";
import { isDataWipeFenceError } from "../../privacy/data-wipe-fence.js";
import { captureError } from "../../sentry.js";
import type {
  CalendarSession,
  CalendarWindow,
  MeetingListing,
} from "../calendar-providers/types.js";
import type { CalendarProviderName } from "../calendar-rows.js";
import { type CountedMeeting, countMeeting, utcDayOf } from "./coattendance-rules.js";
import { isPassDue, readSourceState, recordPassSucceeded } from "./coattendance-sources.js";
import {
  loadOwnAddresses,
  pruneCountedMeetings,
  type RecordResult,
  recordCountedMeetings,
} from "./coattendance-store.js";

export const COATTENDANCE_LOOKBACK_DAYS = 30;
export const COATTENDANCE_PASS_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const COATTENDANCE_FAILURE_BACKOFF_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Markers keep only a day, so they are kept one day past the window. */
const MARKER_GRACE_MS = DAY_MS;
/** Sources whose failure backoff is remembered; the oldest is forgotten past the cap. */
const MAX_REMEMBERED_SOURCES = 10_000;

export interface CoAttendancePassResult extends RecordResult {
  readonly truncated: boolean;
}

const retryAfter = new Map<string, number>();
const inFlight = new Set<string>();

export function _resetCoAttendancePassesForTests(): void {
  retryAfter.clear();
  inFlight.clear();
}

function backOff(source: string, now: Date): void {
  retryAfter.delete(source);
  if (retryAfter.size >= MAX_REMEMBERED_SOURCES) {
    const oldest = retryAfter.keys().next().value;
    if (oldest !== undefined) retryAfter.delete(oldest);
  }
  retryAfter.set(source, now.getTime() + COATTENDANCE_FAILURE_BACKOFF_MS);
}

function backingOff(source: string, now: Date): boolean {
  const until = retryAfter.get(source);
  return until !== undefined && now.getTime() < until;
}

export function coAttendanceWindow(now: Date): CalendarWindow {
  return {
    timeMin: new Date(now.getTime() - COATTENDANCE_LOOKBACK_DAYS * DAY_MS).toISOString(),
    timeMax: now.toISOString(),
  };
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

async function runPass(
  list: (window: CalendarWindow) => Promise<MeetingListing>,
  provider: CalendarProviderName,
  userId: string,
  now: Date,
): Promise<CoAttendancePassResult> {
  const window = coAttendanceWindow(now);
  const listing = await list(window);
  let recorded: RecordResult = { meetings: 0, contacts: 0 };
  if (listing.meetings.length > 0) {
    const own = await loadOwnAddresses(userId);
    const counted = listing.meetings
      .map((meeting) => countMeeting(meeting, own, now))
      .filter((meeting): meeting is CountedMeeting => meeting !== null);
    recorded = await recordCountedMeetings(provider, userId, counted);
  }
  const windowStart = new Date(window.timeMin);
  await pruneCountedMeetings(userId, new Date(windowStart.getTime() - MARKER_GRACE_MS));
  return { ...recorded, truncated: listing.truncated };
}

/**
 * Count the ended meetings of one Google calendar source. Null when nothing ran:
 * the flag is off, the provider cannot list attendees, the user has no such Google
 * source, its interval has not passed, it is backing off after a failure, a pass
 * for it is already running, or the pass failed (reported, never thrown).
 */
export async function countCoAttendance(
  session: CalendarSession,
  userId: string,
  linkedAccountId: string | null,
  now: Date = new Date(),
): Promise<CoAttendancePassResult | null> {
  if (!calendarCoattendanceEnabled()) return null;
  if (!session.listMeetingAttendees) return null;
  const list = session.listMeetingAttendees.bind(session);
  const source = `${userId}:${linkedAccountId ?? "primary"}`;
  if (backingOff(source, now) || inFlight.has(source)) return null;
  inFlight.add(source);
  try {
    const state = await readSourceState(userId, linkedAccountId);
    if (!state || !isPassDue(state, now, COATTENDANCE_PASS_INTERVAL_MS)) return null;
    const result = await runPass(list, session.provider, userId, now);
    const windowStartDay = utcDayOf(new Date(coAttendanceWindow(now).timeMin));
    await recordPassSucceeded(userId, linkedAccountId, state, windowStartDay, now);
    retryAfter.delete(source);
    if (result.meetings > 0 || result.truncated) {
      console.log(
        `[CALENDAR] co-attendance ${source} meetings=${result.meetings} contacts=${result.contacts} truncated=${result.truncated}`,
      );
    }
    return result;
  } catch (err) {
    backOff(source, now);
    // The account's data is being wiped: the refusal is the fence working.
    if (isDataWipeFenceError(err)) return null;
    const label = failureLabel(err);
    console.warn(`[CALENDAR] co-attendance pass failed for ${source}: ${label}`);
    captureError(new Error(`calendar co-attendance pass failed: ${label}`), {
      tags: { scope: "calendar.coattendance" },
      extra: { userId, linkedAccountId },
    });
    return null;
  } finally {
    inFlight.delete(source);
  }
}
