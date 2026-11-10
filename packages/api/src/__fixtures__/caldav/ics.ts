/**
 * iCalendar fixtures for the CalDAV connector tests (step C3). Written by hand from
 * the shapes in RFC 5545 (sections 3.6.1, 3.6.5, 3.8.4.4, 3.8.5.1, 3.8.5.3 and the
 * examples in 3.6.1 and 4) and RFC 4791 appendix B, in the two shapes the providers
 * use: iCloud (a VTIMEZONE per TZID, an Apple-style PRODID) and Naver (Asia/Seoul).
 * No real user data: every address is example.com / example.net.
 *
 * The test window is 2026-10-01T00:00:00Z to 2026-10-31T00:00:00Z.
 */

const CRLF = "\r\n";

export function ics(...lines: string[]): string {
  return [...lines, ""].join(CRLF);
}

const NEW_YORK = [
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

const SEOUL = [
  "BEGIN:VTIMEZONE",
  "TZID:Asia/Seoul",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0900",
  "TZOFFSETTO:+0900",
  "TZNAME:KST",
  "DTSTART:19700101T000000",
  "END:STANDARD",
  "END:VTIMEZONE",
];

/** iCloud shape: a timed event in New York, with a URL. 13:00Z-14:00Z on 2026-10-05. */
export const ICLOUD_TIMED = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Apple Inc.//macOS 15.0//EN",
  "CALSCALE:GREGORIAN",
  ...NEW_YORK,
  "BEGIN:VEVENT",
  "UID:7A1C0F2E-0001-4B7E-9E1A-EXAMPLE00001",
  "DTSTAMP:20260920T120000Z",
  "CREATED:20260920T120000Z",
  "DTSTART;TZID=America/New_York:20261005T090000",
  "DTEND;TZID=America/New_York:20261005T100000",
  "SUMMARY:Design review",
  "DESCRIPTION:Agenda:\\nwalk through the mocks\\, then decide",
  "LOCATION:Room 4\\; 2nd floor",
  "URL;VALUE=URI:https://meet.example.com/abc-defg-hij",
  "SEQUENCE:0",
  "END:VEVENT",
  "END:VCALENDAR",
);

/** iCloud shape: an all-day event (DATE values, end exclusive), transparent as iCloud marks them. */
export const ICLOUD_ALL_DAY = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Apple Inc.//macOS 15.0//EN",
  "BEGIN:VEVENT",
  "UID:7A1C0F2E-0002-4B7E-9E1A-EXAMPLE00002",
  "DTSTAMP:20260920T120000Z",
  "DTSTART;VALUE=DATE:20261009",
  "DTEND;VALUE=DATE:20261010",
  "SUMMARY:Hangul Day",
  "TRANSP:TRANSPARENT",
  "END:VEVENT",
  "END:VCALENDAR",
);

/**
 * Naver shape: a weekly series in Seoul (Mondays 10:00 KST = 01:00Z) with an
 * EXDATE (Oct 12), an override that moves Oct 19 to 15:00 KST (06:00Z) and a
 * cancelled override on Oct 26. In the window: Oct 5 and Oct 19 only.
 */
export const NAVER_WEEKLY = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Example Calendar//KO",
  ...SEOUL,
  "BEGIN:VEVENT",
  "UID:weekly-standup@example.net",
  "DTSTAMP:20260901T000000Z",
  "DTSTART;TZID=Asia/Seoul:20260907T100000",
  "DTEND;TZID=Asia/Seoul:20260907T103000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T000000Z",
  "EXDATE;TZID=Asia/Seoul:20261012T100000",
  "SUMMARY:Weekly standup",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:weekly-standup@example.net",
  "DTSTAMP:20260901T000000Z",
  "RECURRENCE-ID;TZID=Asia/Seoul:20261019T100000",
  "DTSTART;TZID=Asia/Seoul:20261019T150000",
  "DTEND;TZID=Asia/Seoul:20261019T153000",
  "SUMMARY:Weekly standup (moved)",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:weekly-standup@example.net",
  "DTSTAMP:20260901T000000Z",
  "RECURRENCE-ID;TZID=Asia/Seoul:20261026T100000",
  "DTSTART;TZID=Asia/Seoul:20261026T100000",
  "DTEND;TZID=Asia/Seoul:20261026T103000",
  "STATUS:CANCELLED",
  "SUMMARY:Weekly standup",
  "END:VEVENT",
  "END:VCALENDAR",
);

/** A whole event cancelled by its organiser: never a row. */
export const CANCELLED_EVENT = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Example Calendar//EN",
  "BEGIN:VEVENT",
  "UID:cancelled-1@example.com",
  "DTSTAMP:20260901T000000Z",
  "DTSTART:20261014T090000Z",
  "DTEND:20261014T100000Z",
  "STATUS:CANCELLED",
  "SUMMARY:Called off",
  "END:VEVENT",
  "END:VCALENDAR",
);

/** UTC times with a DURATION instead of DTEND, and a conference link (RFC 7986). 12:00Z-12:30Z. */
export const UTC_WITH_DURATION = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Example Calendar//EN",
  "BEGIN:VEVENT",
  "UID:utc-duration@example.com",
  "DTSTAMP:20260901T000000Z",
  "DTSTART:20261015T120000Z",
  "DURATION:PT30M",
  "SUMMARY:Quick sync",
  "CONFERENCE;VALUE=URI;FEATURE=VIDEO:https://video.example.com/j/123",
  "URL:javascript:alert(1)",
  "END:VEVENT",
  "END:VCALENDAR",
);

/** A floating time (no zone): read in the user's zone. 09:00 local on 2026-10-20. */
export const FLOATING = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Example Calendar//EN",
  "BEGIN:VEVENT",
  "UID:floating@example.com",
  "DTSTAMP:20260901T000000Z",
  "DTSTART:20261020T090000",
  "DTEND:20261020T100000",
  "SUMMARY:Floating",
  "URL:http://insecure.example.com/x",
  "END:VEVENT",
  "END:VCALENDAR",
);

/** A TZID Intl does not know, defined by its own VTIMEZONE (+05:30). 09:00 local = 03:30Z on 2026-10-07. */
export const CUSTOM_ZONE = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Example Calendar//EN",
  "BEGIN:VTIMEZONE",
  "TZID:Custom Zone (India)",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0530",
  "TZOFFSETTO:+0530",
  "DTSTART:19700101T000000",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:custom-zone@example.com",
  "DTSTAMP:20260901T000000Z",
  "DTSTART;TZID=Custom Zone (India):20261007T090000",
  "DTEND;TZID=Custom Zone (India):20261007T100000",
  "SUMMARY:Custom zone",
  "END:VEVENT",
  "END:VCALENDAR",
);

/**
 * A daily series that starts after the window (Nov 2-4) with its first instance
 * moved INTO the window (Oct 28, 10:00Z-11:00Z). The listing must still find it.
 */
export const MOVED_INTO_WINDOW = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Example Calendar//EN",
  "BEGIN:VEVENT",
  "UID:moved-in@example.com",
  "DTSTAMP:20260901T000000Z",
  "DTSTART:20261102T100000Z",
  "DTEND:20261102T110000Z",
  "RRULE:FREQ=DAILY;COUNT=3",
  "SUMMARY:Offsite",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:moved-in@example.com",
  "DTSTAMP:20260901T000000Z",
  "RECURRENCE-ID:20261102T100000Z",
  "DTSTART:20261028T100000Z",
  "DTEND:20261028T110000Z",
  "SUMMARY:Offsite (pulled forward)",
  "END:VEVENT",
  "END:VCALENDAR",
);

/** A per-second series running since 2020: the iteration cap stops it before the window, so the listing is incomplete. */
export const ENDLESS_SECONDLY = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Example Calendar//EN",
  "BEGIN:VEVENT",
  "UID:secondly@example.com",
  "DTSTAMP:20260901T000000Z",
  "DTSTART:20200101T000000Z",
  "DTEND:20200101T000001Z",
  "RRULE:FREQ=SECONDLY",
  "SUMMARY:Too many",
  "END:VEVENT",
  "END:VCALENDAR",
);

/** Not iCalendar at all. */
export const MALFORMED = "BEGIN:VCALENDAR\r\nthis is not a content line\r\nEND:VCALENDAR\r\n";

/** A VEVENT with no DTSTART: unreadable, never a guessed time. */
export const NO_START = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Example Calendar//EN",
  "BEGIN:VEVENT",
  "UID:no-start@example.com",
  "DTSTAMP:20260901T000000Z",
  "SUMMARY:No start",
  "END:VEVENT",
  "END:VCALENDAR",
);

/** Outside the window entirely (November): the server's widened range may return it; it is not listed. */
export const OUTSIDE_WINDOW = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Example Calendar//EN",
  "BEGIN:VEVENT",
  "UID:outside@example.com",
  "DTSTAMP:20260901T000000Z",
  "DTSTART:20261031T120000Z",
  "DTEND:20261031T130000Z",
  "SUMMARY:Next month",
  "END:VEVENT",
  "END:VCALENDAR",
);

/** `count` single timed events, one per hour from 2026-10-02T00:00Z, ids `bulk-<n>@example.com`. */
export function bulkEvents(count: number): string[] {
  return Array.from({ length: count }, (_, n) => {
    const start = new Date(Date.UTC(2026, 9, 2, n));
    const stamp = (d: Date) =>
      d
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "");
    return ics(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Example Calendar//EN",
      "BEGIN:VEVENT",
      `UID:bulk-${n}@example.com`,
      "DTSTAMP:20260901T000000Z",
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(new Date(start.getTime() + 30 * 60_000))}`,
      `SUMMARY:Bulk ${n}`,
      "END:VEVENT",
      "END:VCALENDAR",
    );
  });
}
