/**
 * Tests for the defensive Google Calendar time parser.
 *
 * The 2026-06-04 prod bug: events were stored at +13h shift relative to
 * what Google actually had. The shift matched KST(+9) → EDT(-4) — a
 * 13-hour delta — which is the signature of either an LLM-generated
 * dateTime with the wrong offset OR a naive dateTime parsed as
 * server-local UTC.
 *
 * These tests lock down the fix path: any dateTime without an explicit
 * offset must combine with the event's stored timeZone metadata (or the
 * user's stored zone as fallback) instead of being passed naked to
 * `new Date(...)`.
 */

import { describe, expect, it } from "vitest";
import {
  calendarLabelMap,
  hasExplicitOffset,
  mapGoogleEventTimes,
  naiveLocalToUtc,
  parseGoogleDateTime,
  selectFreeBusyCalendarIds,
  summarizeConflicts,
  summarizeFreeBusy,
  toAbsoluteInstant,
} from "../google-calendar-time.js";

describe("hasExplicitOffset", () => {
  it.each([
    "2026-06-03T15:00:00+09:00",
    "2026-06-03T15:00:00-04:00",
    "2026-06-03T15:00:00Z",
    "2026-06-03T15:00:00.123Z",
    "2026-06-03T15:00:00+0900",
  ])("detects offset in %s", (input) => {
    expect(hasExplicitOffset(input)).toBe(true);
  });

  it.each([
    "2026-06-03T15:00:00",
    "2026-06-03T15:00",
    "2026-06-03T15:00:00.123",
  ])("rejects naive %s", (input) => {
    expect(hasExplicitOffset(input)).toBe(false);
  });
});

describe("naiveLocalToUtc", () => {
  it("returns the correct UTC moment for a KST wall-clock time", () => {
    // 2026-06-03 15:00 KST = 2026-06-03 06:00 UTC
    const utc = naiveLocalToUtc("2026-06-03T15:00:00", "Asia/Seoul");
    expect(utc).not.toBeNull();
    expect(utc?.toISOString()).toBe("2026-06-03T06:00:00.000Z");
  });

  it("returns the correct UTC moment for an EDT wall-clock time", () => {
    // 2026-06-03 15:00 America/New_York (EDT in June) = 2026-06-03 19:00 UTC
    const utc = naiveLocalToUtc("2026-06-03T15:00:00", "America/New_York");
    expect(utc).not.toBeNull();
    expect(utc?.toISOString()).toBe("2026-06-03T19:00:00.000Z");
  });

  it("handles wall-clock crossing midnight in KST", () => {
    // 2026-06-04 00:30 KST = 2026-06-03 15:30 UTC
    const utc = naiveLocalToUtc("2026-06-04T00:30:00", "Asia/Seoul");
    expect(utc?.toISOString()).toBe("2026-06-03T15:30:00.000Z");
  });

  it("returns null for an unparseable string", () => {
    expect(naiveLocalToUtc("not a date", "Asia/Seoul")).toBeNull();
  });

  it("accepts HH:MM (no seconds)", () => {
    const utc = naiveLocalToUtc("2026-06-03T15:00", "Asia/Seoul");
    expect(utc?.toISOString()).toBe("2026-06-03T06:00:00.000Z");
  });
});

describe("parseGoogleDateTime", () => {
  it("uses the offset when present — no double interpretation", () => {
    // Google returned canonical RFC3339 with +09:00. Anything that
    // reinterprets via timeZone would re-shift the moment and create
    // a new bug. Just parse it.
    const d = parseGoogleDateTime("2026-06-03T15:00:00+09:00", "Asia/Seoul", "Asia/Seoul");
    expect(d.toISOString()).toBe("2026-06-03T06:00:00.000Z");
  });

  it("uses Z offset when present", () => {
    const d = parseGoogleDateTime("2026-06-03T06:00:00Z", "Asia/Seoul", "Asia/Seoul");
    expect(d.toISOString()).toBe("2026-06-03T06:00:00.000Z");
  });

  it("uses the event timezone for a naive dateTime", () => {
    // Google sometimes returns dateTime without offset when the caller
    // explicitly requested timeZone. The event's start.timeZone field
    // is the canonical interpretation in that case.
    const d = parseGoogleDateTime("2026-06-03T15:00:00", "Asia/Seoul", "America/New_York");
    expect(d.toISOString()).toBe("2026-06-03T06:00:00.000Z");
  });

  it("falls back to the user timezone when event has no zone metadata", () => {
    const d = parseGoogleDateTime("2026-06-03T15:00:00", null, "Asia/Seoul");
    expect(d.toISOString()).toBe("2026-06-03T06:00:00.000Z");
  });

  it("re-interpreting a naive KST string as Asia/Seoul does NOT yield the +13h shift", () => {
    // Regression test for the production bug. Before the fix, the sync
    // path did `new Date("2026-06-03T15:00:00")` which on Render UTC
    // server stored 15:00 UTC = 24:00 KST, and the agent path could
    // produce a -04:00 offset string that stored 19:00 UTC = 04:00 KST
    // next day. Both modes are fixed by routing through this helper.
    const d = parseGoogleDateTime("2026-06-03T15:00:00", "Asia/Seoul", "Asia/Seoul");
    expect(d.toISOString()).not.toBe("2026-06-03T15:00:00.000Z"); // not naive UTC
    expect(d.toISOString()).not.toBe("2026-06-03T19:00:00.000Z"); // not the -04:00 mis-shift
    expect(d.toISOString()).toBe("2026-06-03T06:00:00.000Z"); // canonical KST
  });
});

describe("mapGoogleEventTimes (shared init-sync + scheduler mapping)", () => {
  it("applies the user timezone to a naive timed event (not naive new Date)", () => {
    // The init-sync bug: it used `new Date(startTime)` which on the Render UTC
    // server stored 15:00 UTC instead of the user's 15:00 KST. The shared
    // mapper must produce the timezone-aware instant, matching the scheduler.
    const mapped = mapGoogleEventTimes(
      {
        start: { dateTime: "2026-06-03T15:00:00", timeZone: "Asia/Seoul" },
        end: { dateTime: "2026-06-03T16:00:00", timeZone: "Asia/Seoul" },
      },
      "Asia/Seoul",
    );
    // Deterministic: the timezone-aware instant is 06:00 UTC regardless of the
    // server's own TZ. (A naive `new Date(rawString)` would store 15:00 UTC on
    // the Render UTC box — the exact init-sync bug.)
    expect(mapped?.startTime.toISOString()).toBe("2026-06-03T06:00:00.000Z");
    expect(mapped?.endTime.toISOString()).toBe("2026-06-03T07:00:00.000Z");
    expect(mapped?.allDay).toBe(false);
  });

  it("matches parseGoogleDateTime exactly (same instant as the scheduler)", () => {
    const mapped = mapGoogleEventTimes(
      { start: { dateTime: "2026-06-03T15:00:00" }, end: { dateTime: "2026-06-03T16:00:00" } },
      "Asia/Seoul",
    );
    expect(mapped?.startTime.toISOString()).toBe(
      parseGoogleDateTime("2026-06-03T15:00:00", null, "Asia/Seoul").toISOString(),
    );
  });

  it("trusts an explicit offset", () => {
    const mapped = mapGoogleEventTimes(
      {
        start: { dateTime: "2026-06-03T15:00:00+09:00" },
        end: { dateTime: "2026-06-03T16:00:00+09:00" },
      },
      "America/New_York",
    );
    expect(mapped?.startTime.toISOString()).toBe("2026-06-03T06:00:00.000Z");
  });

  it("treats a date-only event as all-day", () => {
    const mapped = mapGoogleEventTimes(
      { start: { date: "2026-06-03" }, end: { date: "2026-06-04" } },
      "Asia/Seoul",
    );
    expect(mapped?.allDay).toBe(true);
    expect(mapped?.startTime.toISOString()).toBe(new Date("2026-06-03").toISOString());
  });

  it("returns null when start or end is missing", () => {
    expect(
      mapGoogleEventTimes({ start: { dateTime: "2026-06-03T15:00:00" } }, "Asia/Seoul"),
    ).toBeNull();
    expect(mapGoogleEventTimes({}, "Asia/Seoul")).toBeNull();
  });
});

describe("toAbsoluteInstant (conflict-window normalizer)", () => {
  it("trusts an offset-bearing time verbatim (KST)", () => {
    // 2026-06-03 15:00 +09:00 = 06:00 UTC
    expect(toAbsoluteInstant("2026-06-03T15:00:00+09:00", "Asia/Seoul")).toBe(
      "2026-06-03T06:00:00.000Z",
    );
  });

  it("trusts a Z time regardless of user zone", () => {
    expect(toAbsoluteInstant("2026-06-03T06:00:00Z", "America/New_York")).toBe(
      "2026-06-03T06:00:00.000Z",
    );
  });

  it("reads a naive (offset-less) time in the USER's zone, not server UTC", () => {
    // Regression: the agent sometimes drops the offset. Reading 15:00 as the
    // user's KST wall clock = 06:00 UTC; reading it as naive UTC (the bug) would
    // query a window 9h off and miss/invent a clash.
    const out = toAbsoluteInstant("2026-06-03T15:00:00", "Asia/Seoul");
    expect(out).toBe("2026-06-03T06:00:00.000Z");
    expect(out).not.toBe("2026-06-03T15:00:00.000Z");
  });

  it("reads a naive time in a non-KST user zone (cross-tz safety)", () => {
    // 2026-06-03 15:00 America/New_York (EDT) = 19:00 UTC
    expect(toAbsoluteInstant("2026-06-03T15:00:00", "America/New_York")).toBe(
      "2026-06-03T19:00:00.000Z",
    );
  });

  it("returns null for an unparseable or empty time", () => {
    expect(toAbsoluteInstant("not a date", "Asia/Seoul")).toBeNull();
    expect(toAbsoluteInstant("", "Asia/Seoul")).toBeNull();
  });
});

describe("summarizeConflicts (all-day false-positive guard)", () => {
  it("excludes all-day (date-only) events — they don't double-book a time slot", () => {
    const out = summarizeConflicts([
      {
        id: "allday",
        summary: "Company Holiday",
        start: { date: "2026-06-03" },
        end: { date: "2026-06-04" },
      },
    ]);
    expect(out).toHaveLength(0);
  });

  it("counts a timed event as a conflict", () => {
    const out = summarizeConflicts([
      {
        id: "timed",
        summary: "1:1",
        start: { dateTime: "2026-06-03T14:00:00+09:00" },
        end: { dateTime: "2026-06-03T15:00:00+09:00" },
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "timed",
      summary: "1:1",
      start: "2026-06-03T14:00:00+09:00",
      end: "2026-06-03T15:00:00+09:00",
    });
  });

  it("keeps only the timed event when an all-day event overlaps the window", () => {
    const out = summarizeConflicts([
      {
        id: "allday",
        summary: "Birthday",
        start: { date: "2026-06-03" },
        end: { date: "2026-06-04" },
      },
      {
        id: "timed",
        summary: "Standup",
        start: { dateTime: "2026-06-03T09:30:00+09:00" },
        end: { dateTime: "2026-06-03T10:00:00+09:00" },
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("timed");
  });

  it("defaults a missing summary to (No title)", () => {
    const out = summarizeConflicts([
      {
        id: "x",
        start: { dateTime: "2026-06-03T09:30:00+09:00" },
        end: { dateTime: "2026-06-03T10:00:00+09:00" },
      },
    ]);
    expect(out[0]?.summary).toBe("(No title)");
  });

  it("tolerates an empty list", () => {
    expect(summarizeConflicts([])).toEqual([]);
  });
});

describe("selectFreeBusyCalendarIds (multi-calendar selection)", () => {
  it("keeps primary + owner/writer calendars (the user's double-book risk)", () => {
    const ids = selectFreeBusyCalendarIds([
      { id: "primary", primary: true, accessRole: "owner" },
      { id: "work@group.calendar.google.com", accessRole: "writer" },
      { id: "owned2@group.calendar.google.com", accessRole: "owner" },
    ]);
    expect(ids).toEqual([
      "primary",
      "work@group.calendar.google.com",
      "owned2@group.calendar.google.com",
    ]);
  });

  it("drops reader / freeBusyReader subscriptions (someone else's busy ≠ my clash)", () => {
    const ids = selectFreeBusyCalendarIds([
      { id: "primary", primary: true, accessRole: "owner" },
      { id: "holidays@group.v.calendar.google.com", accessRole: "reader" },
      { id: "coworker@company.com", accessRole: "freeBusyReader" },
    ]);
    expect(ids).toEqual(["primary"]);
  });

  it("tolerates null/empty and skips items with no id", () => {
    expect(selectFreeBusyCalendarIds(null)).toEqual([]);
    expect(selectFreeBusyCalendarIds([{ accessRole: "owner" }])).toEqual([]);
  });
});

describe("calendarLabelMap (never leak the raw email-form calendar id)", () => {
  it("labels primary as 'primary' and secondaries by their display name", () => {
    const map = calendarLabelMap([
      { id: "alice@company.com", primary: true, summary: "alice@company.com" },
      { id: "abc123@group.calendar.google.com", summary: "Work" },
      { id: "def456@group.calendar.google.com", summary: "Team", summaryOverride: "Team (mine)" },
    ]);
    expect(map).toEqual({
      "alice@company.com": "primary",
      "abc123@group.calendar.google.com": "Work",
      "def456@group.calendar.google.com": "Team (mine)",
    });
  });

  it("falls back to a generic label and skips id-less entries", () => {
    expect(calendarLabelMap([{ id: "x@group.calendar.google.com" }])).toEqual({
      "x@group.calendar.google.com": "calendar",
    });
    expect(calendarLabelMap([{ summary: "no id" }])).toEqual({});
    expect(calendarLabelMap(null)).toEqual({});
  });
});

describe("summarizeFreeBusy (flatten busy intervals across calendars)", () => {
  it("tags each block with the mapped label — never the raw (email) calendar id", () => {
    const out = summarizeFreeBusy(
      {
        "alice@company.com": {
          busy: [{ start: "2026-06-03T05:00:00Z", end: "2026-06-03T06:00:00Z" }],
        },
        "work@group.calendar.google.com": {
          busy: [{ start: "2026-06-03T07:00:00Z", end: "2026-06-03T08:00:00Z" }],
        },
      },
      { "alice@company.com": "primary", "work@group.calendar.google.com": "Work" },
    );
    expect(out).toEqual([
      { start: "2026-06-03T05:00:00Z", end: "2026-06-03T06:00:00Z", calendar: "primary" },
      { start: "2026-06-03T07:00:00Z", end: "2026-06-03T08:00:00Z", calendar: "Work" },
    ]);
  });

  it("degrades to a non-identifying label when no map entry exists", () => {
    const out = summarizeFreeBusy({
      primary: { busy: [{ start: "2026-06-03T05:00:00Z", end: "2026-06-03T06:00:00Z" }] },
      "secret@company.com": {
        busy: [{ start: "2026-06-03T07:00:00Z", end: "2026-06-03T08:00:00Z" }],
      },
    });
    expect(out.map((c) => c.calendar)).toEqual(["primary", "calendar"]);
  });

  it("returns empty when no calendar is busy, and skips malformed slots", () => {
    expect(summarizeFreeBusy({ primary: { busy: [] } })).toEqual([]);
    expect(summarizeFreeBusy({ primary: { busy: [{ start: "2026-06-03T05:00:00Z" }] } })).toEqual(
      [],
    );
    expect(summarizeFreeBusy(null)).toEqual([]);
  });
});
