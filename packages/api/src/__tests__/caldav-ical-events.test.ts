/**
 * C3: iCalendar objects from a CalDAV calendar-query become the window's
 * occurrences. All-day events (UTC midnight rows, like Google's), time zones
 * (an IANA TZID, a TZID only its own VTIMEZONE defines, UTC, floating), RRULE
 * expansion within the window, EXDATE, RECURRENCE-ID overrides (moved, cancelled,
 * moved into the window from outside), STATUS:CANCELLED, and the https-only meeting
 * link. Anything that cannot be read is counted, never guessed, so the sync never
 * deletes a row on a misread.
 */

import ICAL from "ical.js";
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
import {
  CALDAV_MAX_DESCRIPTION_LENGTH,
  CALDAV_MAX_SERIES_ITERATIONS,
  CALDAV_MAX_TOTAL_ITERATIONS,
  occurrencesInWindow,
} from "../pim/caldav/ical-events.js";
import {
  MAX_RECUR_SPINS_PER_LISTING,
  MAX_RECUR_SPINS_PER_STEP,
  MAX_RRULES_PER_EVENT,
} from "../pim/caldav/ical-recur-guard.js";

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

  it("once the listing's step cap is spent, later series are cut at once", () => {
    const runaways = Math.ceil(CALDAV_MAX_TOTAL_ITERATIONS / CALDAV_MAX_SERIES_ITERATIONS);
    const endless = Array.from({ length: runaways }, (_, n) =>
      ENDLESS_SECONDLY.replace("secondly@example.com", `secondly-${n}@example.com`),
    );
    const result = only([...endless, daily]);
    expect(result.truncated).toBe(true);
    expect(result.occurrences.filter((e) => e.externalId.startsWith("daily-since-2010"))).toEqual(
      [],
    );
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

// Review findings (2026-10-01): ical.js's RecurIterator.next() never returns for
// a rule that can never match (its DAILY/WEEKLY search loop has no bound), and a
// huge INTERVAL makes one step take forever. A calendar is external content (a
// spam invitation lands in it), so either would hang the API process.
describe("hostile and impossible recurrence rules", () => {
  function series(uid: string, rule: string, start = "20240101T100000Z"): string {
    return ics(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Example Calendar//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      "DTSTAMP:20260901T000000Z",
      `DTSTART:${start}`,
      "DURATION:PT1H",
      `RRULE:${rule}`,
      "END:VEVENT",
      "END:VCALENDAR",
    );
  }

  it.each([
    "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30",
    "FREQ=DAILY;BYMONTH=4;BYMONTHDAY=31;COUNT=5",
    "FREQ=SECONDLY;BYMONTH=2;BYMONTHDAY=30",
    "FREQ=WEEKLY;INTERVAL=100000000;BYDAY=MO",
  ])("%s is unreadable, returns, and the rest of the listing survives", {
    timeout: 15_000,
  }, (rule) => {
    const result = only([series("bad@example.com", rule), ICLOUD_TIMED]);
    expect(result.unreadable).toBe(1);
    expect(result.occurrences.map((e) => e.externalId)).toEqual([
      "7A1C0F2E-0001-4B7E-9E1A-EXAMPLE00001",
    ]);
  });

  // Without the per-occurrence bound one impossible rule would spend the whole
  // listing budget and take every later series down with it.
  it("one impossible series spends its own bound, not the listing's", () => {
    const impossible = series("bad@example.com", "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30");
    const leap = series(
      "leap-monday@example.com",
      "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29;BYDAY=MO;COUNT=3",
      "20000101T100000Z",
    );
    const result = occurrencesInWindow(
      [impossible, leap],
      { start: new Date("2044-02-28T00:00:00Z"), end: new Date("2044-03-01T00:00:00Z") },
      "UTC",
    );
    expect(result.unreadable).toBe(1);
    expect(result.occurrences.map((e) => iso(e.startTime))).toEqual(["2044-02-29T10:00:00.000Z"]);
  });

  it("once the listing's search budget is spent, every later series is unreadable", {
    timeout: 30_000,
  }, () => {
    const enough = MAX_RECUR_SPINS_PER_LISTING / MAX_RECUR_SPINS_PER_STEP;
    const hostile = Array.from({ length: enough }, (_, n) =>
      series(`bad-${n}@example.com`, "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30"),
    );
    const daily = series("daily-after@example.com", "FREQ=DAILY", "20261001T100000Z");
    const result = only([...hostile, daily, ICLOUD_TIMED]);
    expect(result.unreadable).toBe(enough + 1);
    expect(result.occurrences.map((e) => e.externalId)).toEqual([
      "7A1C0F2E-0001-4B7E-9E1A-EXAMPLE00001",
    ]);
  });

  // ical.js scans every RRULE's iterator on every step: 10 000 RRULEs in one
  // 340 KB object blocked the event loop for 6.5 s. RFC 5545 expects one.
  it("a VEVENT with more RRULEs than the bound is unreadable; the bound itself still reads", () => {
    const withRules = (uid: string, count: number) =>
      ics(
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Example Calendar//EN",
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTAMP:20260901T000000Z",
        "DTSTART:20261001T100000Z",
        "DURATION:PT1H",
        ...Array.from({ length: count }, (_, n) => `RRULE:FREQ=WEEKLY;INTERVAL=${n + 1}`),
        "END:VEVENT",
        "END:VCALENDAR",
      );
    const over = only([withRules("many-rules@example.com", MAX_RRULES_PER_EVENT + 1)]);
    expect(over.unreadable).toBe(1);
    expect(over.occurrences).toEqual([]);
    const at = only([withRules("ten-rules@example.com", MAX_RRULES_PER_EVENT)]);
    expect(at.unreadable).toBe(0);
    expect(at.occurrences.length).toBeGreaterThan(0);
  });

  // No bound of ours on BYxxx lists: ical.js 2.2.1 refuses an out-of-range value and
  // keeps only distinct values, so a list cannot outgrow its range however long the
  // text. Pinned here, since the guard relies on it.
  it("a huge BYxxx list is cut to its distinct values, and an out-of-range one is unreadable", () => {
    const repeated = Array.from({ length: 200_000 }, () => "1").join(",");
    expect(
      ICAL.Recur.fromString(`FREQ=MONTHLY;BYDAY=MO;BYSETPOS=${repeated}`).parts.BYSETPOS,
    ).toEqual([1]);
    const outOfRange = Array.from({ length: 1_001 }, (_, n) => n + 1).join(",");
    const result = only([
      series("out-of-range@example.com", `FREQ=DAILY;BYMONTHDAY=${outOfRange}`),
      ICLOUD_TIMED,
    ]);
    expect(result.unreadable).toBe(1);
    expect(result.occurrences).toHaveLength(1);
  });

  // DTSTART is the first instance (RFC 5545), then 2016-02-29 and 2044-02-29: 28 years of
  // days between the last two, under the per-step search bound.
  it("a sparse but possible rule still expands (Feb 29 on a Monday)", () => {
    const leap = series(
      "leap-monday@example.com",
      "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29;BYDAY=MO;COUNT=3",
      "20000101T100000Z",
    );
    const result = occurrencesInWindow(
      [leap],
      { start: new Date("2044-02-28T00:00:00Z"), end: new Date("2044-03-01T00:00:00Z") },
      "UTC",
    );
    expect(result.unreadable).toBe(0);
    expect(result.occurrences.map((e) => iso(e.startTime))).toEqual(["2044-02-29T10:00:00.000Z"]);
  });
});

// Review finding: with a TZID Intl knows but no VTIMEZONE in the object, ical.js
// cannot match a RECURRENCE-ID or EXDATE written in UTC, so a moved occurrence kept
// the master's time and a deleted one stayed. Overrides and EXDATEs are now matched
// by their instant.
describe("exceptions are matched by instant, whatever form they are written in", () => {
  const SEOUL_NO_VTIMEZONE = ics(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Example Calendar//EN",
    "BEGIN:VEVENT",
    "UID:utc-exceptions@example.net",
    "DTSTAMP:20260901T000000Z",
    "DTSTART;TZID=Asia/Seoul:20261005T100000",
    "DTEND;TZID=Asia/Seoul:20261005T103000",
    "RRULE:FREQ=DAILY;COUNT=3",
    "EXDATE:20261006T010000Z",
    "SUMMARY:Daily",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:utc-exceptions@example.net",
    "DTSTAMP:20260901T000000Z",
    "RECURRENCE-ID:20261007T010000Z",
    "DTSTART;TZID=Asia/Seoul:20261007T150000",
    "DTEND;TZID=Asia/Seoul:20261007T153000",
    "SUMMARY:Daily (moved)",
    "END:VEVENT",
    "END:VCALENDAR",
  );

  // ical.js drops a TZID it has no VTIMEZONE for and reads the value as floating;
  // the user's zone must not stand in for the zone the value was written in.
  it.each([
    SEOUL,
    "America/New_York",
    "UTC",
  ])("a UTC EXDATE removes, and a UTC RECURRENCE-ID moves, a Seoul occurrence (user in %s)", (zone) => {
    const { occurrences, unreadable } = only([SEOUL_NO_VTIMEZONE], zone);
    expect(unreadable).toBe(0);
    expect(occurrences.map((e) => [e.externalId, iso(e.startTime), e.summary])).toEqual([
      ["utc-exceptions@example.net#20261005T010000Z", "2026-10-05T01:00:00.000Z", "Daily"],
      ["utc-exceptions@example.net#20261007T010000Z", "2026-10-07T06:00:00.000Z", "Daily (moved)"],
    ]);
  });

  function seoulDaily(...exdates: string[]): string {
    return ics(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Example Calendar//EN",
      "BEGIN:VEVENT",
      "UID:seoul-exdate@example.net",
      "DTSTAMP:20260901T000000Z",
      "DTSTART;TZID=Asia/Seoul:20261005T100000",
      "DTEND;TZID=Asia/Seoul:20261005T103000",
      "RRULE:FREQ=DAILY;COUNT=3",
      ...exdates,
      "END:VEVENT",
      "END:VCALENDAR",
    );
  }

  // 10:00 in New York is 14:00Z, 13 hours from the 01:00Z Seoul occurrence. With no
  // VTIMEZONE ical.js reads both as floating wall clocks and called them equal.
  it("a single event in a TZID Intl knows, with no VTIMEZONE, is read in that zone", () => {
    const text = ics(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Example Calendar//EN",
      "BEGIN:VEVENT",
      "UID:seoul-single@example.net",
      "DTSTAMP:20260901T000000Z",
      "DTSTART;TZID=Asia/Seoul:20261005T100000",
      "DTEND;TZID=Asia/Seoul:20261005T103000",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    const [event] = only([text], "America/New_York").occurrences;
    expect([iso(event?.startTime ?? null), iso(event?.endTime ?? null)]).toEqual([
      "2026-10-05T01:00:00.000Z",
      "2026-10-05T01:30:00.000Z",
    ]);
  });

  it("an EXDATE at another instant (same wall clock, another zone) removes nothing", () => {
    const { occurrences } = only([seoulDaily("EXDATE;TZID=America/New_York:20261006T100000")]);
    expect(occurrences.map((e) => e.externalId)).toEqual([
      "seoul-exdate@example.net#20261005T010000Z",
      "seoul-exdate@example.net#20261006T010000Z",
      "seoul-exdate@example.net#20261007T010000Z",
    ]);
  });

  it("an EXDATE written as a DATE removes the timed occurrence on that date", () => {
    const { occurrences } = only([seoulDaily("EXDATE;VALUE=DATE:20261006")]);
    expect(occurrences.map((e) => e.externalId)).toEqual([
      "seoul-exdate@example.net#20261005T010000Z",
      "seoul-exdate@example.net#20261007T010000Z",
    ]);
  });

  it("a series in a zone only its VTIMEZONE defines: EXDATE and override by instant", () => {
    const zone = CUSTOM_ZONE.slice(0, CUSTOM_ZONE.indexOf("BEGIN:VEVENT"));
    const text = ics(
      zone.trimEnd(),
      "BEGIN:VEVENT",
      "UID:custom-series@example.com",
      "DTSTAMP:20260901T000000Z",
      "DTSTART;TZID=Custom Zone (India):20261007T090000",
      "DTEND;TZID=Custom Zone (India):20261007T100000",
      "RRULE:FREQ=DAILY;COUNT=3",
      "EXDATE:20261008T033000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:custom-series@example.com",
      "DTSTAMP:20260901T000000Z",
      "RECURRENCE-ID:20261009T033000Z",
      "DTSTART;TZID=Custom Zone (India):20261009T120000",
      "DTEND;TZID=Custom Zone (India):20261009T130000",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    const { occurrences, unreadable } = only([text]);
    expect(unreadable).toBe(0);
    expect(occurrences.map((e) => [e.externalId, iso(e.startTime)])).toEqual([
      ["custom-series@example.com#20261007T033000Z", "2026-10-07T03:30:00.000Z"],
      ["custom-series@example.com#20261009T033000Z", "2026-10-09T06:30:00.000Z"],
    ]);
  });

  it("a long TZID series in the window is cheap enough to finish (daily since 1972, Seoul)", () => {
    const daily = ics(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Example Calendar//EN",
      "BEGIN:VEVENT",
      "UID:seoul-daily@example.net",
      "DTSTAMP:20260901T000000Z",
      "DTSTART;TZID=Asia/Seoul:19720101T090000",
      "DTEND;TZID=Asia/Seoul:19720101T091500",
      "RRULE:FREQ=DAILY",
      "END:VEVENT",
      "END:VCALENDAR",
    );
    const result = only([daily]);
    expect(result.truncated).toBe(false);
    expect(result.occurrences).toHaveLength(30);
    expect(iso(result.occurrences[0]?.startTime ?? null)).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("text is stored safely", () => {
  it("NUL characters are stripped and overlong text is cut to a bound", () => {
    const [event] = only([
      ics(
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Example Calendar//EN",
        "BEGIN:VEVENT",
        "UID:text@example.com",
        "DTSTAMP:20260901T000000Z",
        "DTSTART:20261003T100000Z",
        "DTEND:20261003T110000Z",
        "SUMMARY:A\u0000B",
        `DESCRIPTION:${"d".repeat(CALDAV_MAX_DESCRIPTION_LENGTH + 50)}`,
        "END:VEVENT",
        "END:VCALENDAR",
      ),
    ]).occurrences;
    expect(event.summary).toBe("AB");
    expect(event.description).toHaveLength(CALDAV_MAX_DESCRIPTION_LENGTH);
  });
});
