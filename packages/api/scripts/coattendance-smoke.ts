/**
 * Live smoke of the co-attendance Google listing (pim/calendar-providers/
 * google-meetings.ts) against one real account, for the founder to run before
 * CALENDAR_COATTENDANCE_ENABLED is turned on. Never run in CI.
 *
 * It sends the exact events.list a user's first pass sends (the window's finished
 * days: today − 30 days through yesterday, UTC; same fields mask, eventTypes,
 * maxAttendees, paging) and applies the counting rules, then prints COUNTS ONLY:
 * events listed, eligible meetings, distinct contacts, and why the rest were
 * skipped. It never prints an address, a title or an event id, and it writes no
 * co-attendance data (no counters, markers, watermark or source markers).
 *
 * Usage, from packages/api, either:
 *   GOOGLE_ACCESS_TOKEN=… npx tsx scripts/coattendance-smoke.ts
 *     A bare OAuth access token with calendar.readonly or calendar.events. Only
 *     the calendar owner's `self` entry is known as the user.
 *   DATABASE_URL=… TOKEN_ENCRYPTION_KEYS=… npx tsx scripts/coattendance-smoke.ts --user <userId> [--linked <linkedCalendarAccountId>]
 *     The stored grant of a Klorn user, with all their known addresses. This goes
 *     through the app's own Google client, which, exactly as a calendar sync does,
 *     may REFRESH the stored OAuth token and save the new one (and marks a grant it
 *     cannot decrypt for reconnect). Use the GOOGLE_ACCESS_TOKEN form for a run that
 *     writes nothing at all.
 */

import { google } from "googleapis";
import {
  connectLinkedCalendars,
  connectPrimaryCalendar,
} from "../src/pim/calendar-providers/dispatch.js";
import { googleSessionFromClient } from "../src/pim/calendar-providers/google.js";
import type { CalendarSession, ProviderMeeting } from "../src/pim/calendar-providers/types.js";
import {
  countMeeting,
  MAX_COUNTED_ATTENDEES,
  utcDayOf,
} from "../src/pim/coattendance/coattendance-rules.js";
import { loadOwnAddresses } from "../src/pim/coattendance/coattendance-store.js";
import { COATTENDANCE_LOOKBACK_DAYS } from "../src/pim/coattendance/coattendance-sync.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A first pass's listing: the window's first day through today's midnight (UTC). */
function firstPassWindow(now: Date) {
  const today = utcDayOf(now).getTime();
  const from = today - COATTENDANCE_LOOKBACK_DAYS * DAY_MS;
  return {
    timeMin: new Date(from - 1000).toISOString(),
    timeMax: new Date(today).toISOString(),
  };
}

/** A usage mistake: its message is ours and carries no data, so it is printed. */
class UsageError extends Error {}

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function sessionFor(userId: string | undefined, linkedId: string | undefined) {
  if (!userId) {
    const token = process.env.GOOGLE_ACCESS_TOKEN;
    if (!token) throw new UsageError("set GOOGLE_ACCESS_TOKEN, or pass --user <userId>");
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: token });
    return googleSessionFromClient(auth);
  }
  if (!linkedId) return connectPrimaryCalendar(userId);
  const linked = await connectLinkedCalendars(userId, { skipNeedsReconnect: false });
  return linked.find((account) => account.id === linkedId)?.session ?? null;
}

/** Why a meeting counted nothing, from the rules' inputs; a label, never data. */
function skipReason(meeting: ProviderMeeting, now: Date): string {
  if (!meeting.identity) return "no identity";
  if (meeting.cancelled) return "cancelled";
  if (meeting.allDay) return "all-day";
  if (!meeting.startTime || !meeting.endTime) return "no timed start/end";
  // The rules' cut: a meeting counts once its whole UTC end-day has finished.
  if (meeting.endTime.getTime() >= utcDayOf(now).getTime()) return "end-day not finished";
  if (meeting.attendeesOmitted) return "guest list omitted";
  if (meeting.attendees.filter((a) => !a.resource).length > MAX_COUNTED_ATTENDEES) {
    return "over attendee cap";
  }
  return "user did not take part, or no countable contact";
}

async function main(): Promise<void> {
  const userId = arg("--user");
  const session: CalendarSession | null = await sessionFor(userId, arg("--linked"));
  if (!session?.listMeetingAttendees)
    throw new UsageError("no Google calendar session for that account");
  const now = new Date();
  const listing = await session.listMeetingAttendees(firstPassWindow(now));
  const own = userId ? await loadOwnAddresses(userId) : new Set<string>();
  const contacts = new Set<string>();
  const skipped = new Map<string, number>();
  let eligible = 0;
  let small = 0;
  for (const meeting of listing.meetings) {
    const counted = countMeeting(meeting, own, now);
    if (!counted) {
      const reason = skipReason(meeting, now);
      skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
      continue;
    }
    eligible += 1;
    if (counted.small) small += 1;
    for (const contact of counted.contacts) contacts.add(contact);
  }
  console.log(
    `events listed:      ${listing.meetings.length}${listing.truncated ? " (truncated)" : ""}`,
  );
  console.log(`eligible meetings:  ${eligible} (small: ${small})`);
  console.log(`distinct contacts:  ${contacts.size}`);
  for (const [reason, count] of [...skipped].sort((a, b) => b[1] - a[1])) {
    console.log(`skipped (${reason}): ${count}`);
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    if (err instanceof UsageError) {
      console.error(`usage: ${err.message}`);
      process.exit(2);
    }
    // The class and status only: an error message could quote request data.
    const status = (err as { response?: { status?: number } })?.response?.status;
    console.error(
      `FAIL ${err instanceof Error ? err.name : typeof err}${status ? ` status=${status}` : ""}`,
    );
    process.exit(1);
  },
);
