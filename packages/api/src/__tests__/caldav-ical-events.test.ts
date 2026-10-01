/**
 * C3: iCalendar objects from a CalDAV calendar-query become the window's
 * occurrences. All-day events (UTC midnight rows, like Google's), time zones
 * (an IANA TZID, a TZID only its own VTIMEZONE defines, UTC, floating), RRULE
 * expansion within the window, EXDATE, RECURRENCE-ID overrides (moved, cancelled,
 * moved into the window from outside), STATUS:CANCELLED, and the https-only meeting
 * link. Anything that cannot be read is counted, never guessed, so the sync never
 * deletes a row on a misread.
 */

import { describe, expect, it } from "vitest";
import {
  bulkEvents,
  CANCELLED_EVENT,
  CUSTOM_ZONE,
  ENDLESS_SECONDLY,
  FLOATING,
  ICLOUD_ALL_DAY,
  ICLOUD_TIMED,
  ics,
  MALFORMED,
  MOVED_INTO_WINDOW,
  NAVER_WEEKLY,
  NO_START,
  OUTSIDE_WINDOW,
  UTC_WITH_DURATION,
} from "../__fixtures__/caldav/ics.js";
import { CALDAV_MAX_SERIES_ITERATIONS, occurrencesInWindow } from "../pim/caldav/ical-events.js";

const WINDOW = {
  start: new Date("2026-10-01T00:00:00Z"),
  end: new Date("2026-10-31T00:00:00Z"),
};
const SEOUL = "Asia/Seoul";

function only(objects: string[], zone = SEOUL) {
  return occurrencesInWindow(objects, WINDOW, zone);
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

describe("single events", () => {
  it("a timed event in an IANA zone becomes its UTC instants, text unescaped", () => {
    const { occurrences, unreadable, truncated } = only([ICLOUD_TIMED]);
    expect(unreadable).toBe(0);
    expect(truncated).toBe(false);
    expect(occurrences).toHaveLength(1);
    const [event] = occurrences;
    expect(event.externalId).toBe("7A1C0F2E-0001-4B7E-9E1A-EXAMPLE00001");
    expect(iso(event.startTime)).toBe("2026-10-05T13:00:00.000Z");
    expect(iso(event.endTime)).toBe("2026-10-05T14:00:00.000Z");
    expect(event.start).toBe("2026-10-05T13:00:00.000Z");
    expect(event.allDay).toBe(false);
    expect(event.summary).toBe("Design review");
    expect(event.description).toBe("Agenda:\nwalk through the mocks, then decide");
    expect(event.location).toBe("Room 4; 2nd floor");
    expect(event.meetingLink).toBe("https://meet.example.com/abc-defg-hij");
    expect(event.busy).toBe(true);
  });

  it("an all-day event is UTC midnight of its dates, end exclusive, in any user zone", () => {
    for (const zone of ["Asia/Seoul", "America/Los_Angeles", "UTC"]) {
      const [event] = only([ICLOUD_ALL_DAY], zone).occurrences;
      expect(event.allDay).toBe(true);
      expect(event.start).toBe("2026-10-09");
      expect(event.end).toBe("2026-10-10");
      expect(iso(event.startTime)).toBe("2026-10-09T00:00:00.000Z");
      expect(iso(event.endTime)).toBe("2026-10-10T00:00:00.000Z");
      // All-day and transparent: never busy time.
      expect(event.busy).toBe(false);
    }
  });

  it("UTC times with a DURATION, and a CONFERENCE link preferred over a javascript: URL", () => {
    const [event] = only([UTC_WITH_DURATION]).occurrences;
    expect(iso(event.startTime)).toBe("2026-10-15T12:00:00.000Z");
    expect(iso(event.endTime)).toBe("2026-10-15T12:30:00.000Z");
    expect(event.meetingLink).toBe("https://video.example.com/j/123");
  });

  it("a floating time is read in the user's zone; an http: URL is not a meeting link", () => {
    const [seoul] = only([FLOATING], "Asia/Seoul").occurrences;
    expect(iso(seoul.startTime)).toBe("2026-10-20T00:00:00.000Z");
    const [la] = only([FLOATING], "America/Los_Angeles").occurrences;
    expect(iso(la.startTime)).toBe("2026-10-20T16:00:00.000Z");
    expect(seoul.meetingLink).toBeNull();
  });

  it("a TZID Intl does not know is read through its own VTIMEZONE", () => {
    const [event] = only([CUSTOM_ZONE]).occurrences;
    expect(iso(event.startTime)).toBe("2026-10-07T03:30:00.000Z");
    expect(iso(event.endTime)).toBe("2026-10-07T04:30:00.000Z");
  });

  it("STATUS:CANCELLED on the event: no occurrence", () => {
    const result = only([CANCELLED_EVENT]);
    expect(result.occurrences).toEqual([]);
    expect(result.unreadable).toBe(0);
  });

  it("an event outside the window is left out (the server's range is wider than the window)", () => {
    expect(only([OUTSIDE_WINDOW]).occurrences).toEqual([]);
  });
});

describe("recurring events", () => {
  it("expands a weekly series in the window with EXDATE, a moved and a cancelled override", () => {
    const { occurrences, unreadable } = only([NAVER_WEEKLY]);
    expect(unreadable).toBe(0);
    expect(
      occurrences.map((e) => [e.externalId, iso(e.startTime), iso(e.endTime), e.summary]),
    ).toEqual([
      [
        "weekly-standup@example.net#20261005T010000Z",
        "2026-10-05T01:00:00.000Z",
        "2026-10-05T01:30:00.000Z",
        "Weekly standup",
      ],
      [
        "weekly-standup@example.net#20261019T010000Z",
        "2026-10-19T06:00:00.000Z",
        "2026-10-19T06:30:00.000Z",
        "Weekly standup (moved)",
      ],
    ]);
  });

  it("an instance moved into the window from a later original time is listed", () => {
    const { occurrences } = only([MOVED_INTO_WINDOW]);
    expect(occurrences.map((e) => [e.externalId, iso(e.startTime)])).toEqual([
      ["moved-in@example.com#20261102T100000Z", "2026-10-28T10:00:00.000Z"],
    ]);
  });

  it("a series the iteration cap cannot walk to the window marks the listing truncated", () => {
    expect(CALDAV_MAX_SERIES_ITERATIONS).toBeGreaterThan(1000);
    const result = only([ENDLESS_SECONDLY]);
    expect(result.truncated).toBe(true);
  });

  const daily = ics(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Example Calendar//EN",
    "BEGIN:VEVENT",
    "UID:daily-since-2010@example.com",
    "DTSTAMP:20260901T000000Z",
    "DTSTART:20100101T080000Z",
    "DTEND:20100101T081500Z",
    "RRULE:FREQ=DAILY",
    "SUMMARY:Daily",
    "END:VEVENT",
    "END:VCALENDAR",
  );

  it("one runaway series stops at its own cap and cannot starve the series after it", () => {
    const runaway = ENDLESS_SECONDLY.replace("secondly@example.com", "secondly-2@example.com");
    const result = only([ENDLESS_SECONDLY, runaway, daily]);
    expect(result.truncated).toBe(true);
    expect(
      result.occurrences.filter((e) => e.externalId.startsWith("daily-since-2010")),
    ).toHaveLength(30);
  });

  it("a daily series running since 2010 still reaches the window", () => {
    const result = only([daily]);
    expect(result.truncated).toBe(false);
    expect(result.occurrences).toHaveLength(30);
    expect(result.occurrences[0]?.externalId).toBe("daily-since-2010@example.com#20261001T080000Z");
  });
});

describe("what cannot be read is counted, never guessed", () => {
  it("malformed iCalendar and a VEVENT without DTSTART are unreadable", () => {
    const result = only([MALFORMED, NO_START, ICLOUD_TIMED]);
    expect(result.unreadable).toBe(2);
    expect(result.occurrences.map((e) => e.externalId)).toEqual([
      "7A1C0F2E-0001-4B7E-9E1A-EXAMPLE00001",
    ]);
  });

  it("an overlong UID is hashed into a bounded id instead of being stored as is", () => {
    const uid = `${"x".repeat(600)}@example.com`;
    const [event] = only([
      ics(
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Example Calendar//EN",
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTAMP:20260901T000000Z",
        "DTSTART:20261003T100000Z",
        "DTEND:20261003T110000Z",
        "END:VEVENT",
        "END:VCALENDAR",
      ),
    ]).occurrences;
    expect(event.externalId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(event.summary).toBeNull();
  });
});

describe("ordering", () => {
  it("occurrences come back in start order across objects", () => {
    const starts = only([
      NAVER_WEEKLY,
      ICLOUD_TIMED,
      ICLOUD_ALL_DAY,
      ...bulkEvents(2),
    ]).occurrences.map((e) => iso(e.startTime));
    expect(starts).toEqual([...starts].sort());
  });
});
