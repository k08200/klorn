/**
 * The co-attendance pass a calendar sync runs after its rows are written
 * (pim/calendar-sync.ts), behind CALENDAR_COATTENDANCE_ENABLED. Off: it returns
 * before any listing, read or write.
 *
 * On: for a session that can list attendees (Google, primary and linked), at most
 * once per COATTENDANCE_PASS_INTERVAL_MS per account, it lists the last
 * COATTENDANCE_LOOKBACK_DAYS (the row sync lists only upcoming events, so ended
 * meetings need a listing of their own), counts each ended meeting once per
 * contact (coattendance-rules.ts, coattendance-store.ts), then forgets markers older
 * than any pass can list again. The window is fixed and the markers make every pass
 * idempotent, so the first pass after the flag is turned on also counts the 30
 * days before it, and a missed pass is caught up by the next.
 *
 * Attendee addresses exist only in memory here. Nothing is logged but counts, and
 * a failure is reported by its error class, code and HTTP status only: a database
 * error's message can quote the values of the query that failed.
 *
 * Best effort: it never throws, so it can never fail the row sync.
 */

import { calendarCoattendanceEnabled } from "../../config.js";
import { captureError } from "../../sentry.js";
import type {
  CalendarSession,
  CalendarWindow,
  MeetingListing,
} from "../calendar-providers/types.js";
import type { CalendarProviderName } from "../calendar-rows.js";
import { type CountedMeeting, countMeeting } from "./coattendance-rules.js";
import {
  loadOwnAddresses,
  pruneCountedMeetings,
  type RecordResult,
  recordCountedMeetings,
} from "./coattendance-store.js";

export const COATTENDANCE_LOOKBACK_DAYS = 30;
export const COATTENDANCE_PASS_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Markers are kept one day past the window, so one at its edge is never forgotten early. */
const MARKER_GRACE_MS = DAY_MS;
/** Accounts whose last pass time is remembered; the oldest is forgotten past the cap. */
const MAX_REMEMBERED_ACCOUNTS = 10_000;

export interface CoAttendancePassResult extends RecordResult {
  readonly truncated: boolean;
}

const lastPassAt = new Map<string, number>();

export function _resetCoAttendancePassesForTests(): void {
  lastPassAt.clear();
}

/** True (and the pass recorded) when this account's last pass is at least an interval old. */
function claimPass(account: string, now: Date): boolean {
  const last = lastPassAt.get(account);
  if (last !== undefined && now.getTime() - last < COATTENDANCE_PASS_INTERVAL_MS) return false;
  lastPassAt.delete(account);
  if (lastPassAt.size >= MAX_REMEMBERED_ACCOUNTS) {
    const oldest = lastPassAt.keys().next().value;
    if (oldest !== undefined) lastPassAt.delete(oldest);
  }
  lastPassAt.set(account, now.getTime());
  return true;
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
  const listing = await list(coAttendanceWindow(now));
  let recorded: RecordResult = { meetings: 0, contacts: 0 };
  if (listing.meetings.length > 0) {
    const own = await loadOwnAddresses(userId);
    const counted = listing.meetings
      .map((meeting) => countMeeting(meeting, own, now))
      .filter((meeting): meeting is CountedMeeting => meeting !== null);
    recorded = await recordCountedMeetings(provider, userId, counted);
  }
  const forgetBefore = new Date(
    now.getTime() - COATTENDANCE_LOOKBACK_DAYS * DAY_MS - MARKER_GRACE_MS,
  );
  await pruneCountedMeetings(userId, forgetBefore);
  return { ...recorded, truncated: listing.truncated };
}

/**
 * Count the ended meetings of one calendar account. Null when nothing ran: the flag
 * is off, the provider cannot list attendees, the account's interval has not
 * passed, or the pass failed (reported, never thrown).
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
  const account = `${userId}:${linkedAccountId ?? "primary"}`;
  if (!claimPass(account, now)) return null;
  try {
    const result = await runPass(list, session.provider, userId, now);
    if (result.meetings > 0 || result.truncated) {
      console.log(
        `[CALENDAR] co-attendance ${account} meetings=${result.meetings} contacts=${result.contacts} truncated=${result.truncated}`,
      );
    }
    return result;
  } catch (err) {
    const label = failureLabel(err);
    console.warn(`[CALENDAR] co-attendance pass failed for ${account}: ${label}`);
    captureError(new Error(`calendar co-attendance pass failed: ${label}`), {
      tags: { scope: "calendar.coattendance" },
      extra: { userId, linkedAccountId },
    });
    return null;
  }
}
