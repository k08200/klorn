/**
 * C3 review fixes (2026-10-02): hostile iCalendar must not hold the event loop.
 * Measured before the fix: 20k VEVENTs with COUNT=100000 rules 18 s, one VEVENT
 * with 200k RDATEs 18.6 s (ical.js inserts them one by one), 30k overrides of a
 * DAILY series 2 s (a linear scan of override instants on every step), 60 objects
 * with an impossible rule 1.9 s. The bounds:
 *   - a parse budget per listing, checked between objects and inside a series'
 *     walk: running out marks the listing truncated (and a truncated listing
 *     never removes a row);
 *   - caps per object and per listing on VEVENTs, overrides, RDATEs and EXDATEs:
 *     an object over one is skipped, warned about once, and the listing truncated;
 *   - override instants are looked up in a sorted index, not scanned;
 *   - the work yields to the event loop every slice.
 * These tests assert behaviour on small fixtures, never timing; the before/after
 * times come from a scratch benchmark.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ICLOUD_TIMED, ics, UTC_WITH_DURATION } from "../__fixtures__/caldav/ics.js";
import {
  CALDAV_MAX_PER_LISTING,
  CALDAV_MAX_PER_OBJECT,
  CALDAV_PARSE_SLICE_MS,
  hasInstantNear,
  type IcalCapKind,
} from "../pim/caldav/ical-bounds.js";
import { CALDAV_MAX_SERIES_ITERATIONS, occurrencesInWindow } from "../pim/caldav/ical-events.js";
import { MAX_RECUR_SPINS_PER_STEP } from "../pim/caldav/ical-recur-guard.js";

const WINDOW = {
  start: new Date("2026-10-01T00:00:00Z"),
  end: new Date("2026-10-31T00:00:00Z"),
};
const FROZEN = { now: () => 0 };
const DAY_MS = 24 * 60 * 60 * 1000;

function stamp(instant: Date): string {
  return instant
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function calendar(...vevents: string[][]): string {
  return ics(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Example Calendar//EN",
    ...vevents.flat(),
    "END:VCALENDAR",
  );
}

function vevent(uid: string, ...lines: string[]): string[] {
  return ["BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20260901T000000Z", ...lines, "END:VEVENT"];
}

/** `n` instants one hour apart from 2026-10-02T00:00Z, as UTC stamps. */
function hourly(n: number, from = Date.UTC(2026, 9, 2)): string[] {
  return Array.from({ length: n }, (_, k) => stamp(new Date(from + k * 3_600_000)));
}

/** Values spread over lines of at most 100, as a long list is written. */
function listLines(name: string, values: readonly string[]): string[] {
  const lines: string[] = [];
  for (let k = 0; k < values.length; k += 100) {
    lines.push(`${name}:${values.slice(k, k + 100).join(",")}`);
  }
  return lines;
}

/** One calendar object carrying `n` of `kind`, plus a marker occurrence `<tag>@cap` in the window. */
function objectWith(kind: IcalCapKind, n: number, tag: string): string {
  const uid = `${tag}@cap`;
  switch (kind) {
    case "vevents":
      return calendar(
        ...Array.from({ length: n }, (_, k) =>
          vevent(
            k === 0 ? uid : `${tag}-${k}@cap`,
            "DTSTART:20261003T100000Z",
            "DTEND:20261003T110000Z",
          ),
        ),
      );
    case "overrides":
      return calendar(
        vevent(uid, "DTSTART:20261003T100000Z", "DURATION:PT1H", "RRULE:FREQ=YEARLY;COUNT=1"),
        ...Array.from({ length: n }, (_, k) => {
          const original = stamp(new Date(Date.UTC(2000, 0, 1, 10) + k * DAY_MS));
          return vevent(uid, `RECURRENCE-ID:${original}`, `DTSTART:${original}`, "DURATION:PT1H");
        }),
      );
    case "rdates":
      return calendar(
        vevent(
          uid,
          "DTSTART:20261003T100000Z",
          "DURATION:PT1H",
          // ical.js yields an RDATE-only series without its DTSTART: a rule keeps it.
          "RRULE:FREQ=YEARLY;COUNT=1",
          ...listLines("RDATE", hourly(n, Date.UTC(2027, 0, 1))),
        ),
      );
    case "exdates":
      return calendar(
        vevent(
          uid,
          "DTSTART:20261003T100000Z",
          "DURATION:PT1H",
          "RRULE:FREQ=YEARLY;COUNT=1",
          ...listLines("EXDATE", hourly(n, Date.UTC(2020, 0, 1))),
        ),
      );
  }
}

function idsOf(result: { occurrences: { externalId: string }[] }): string[] {
  return result.occurrences.map((o) => o.externalId.split("#")[0] as string);
}

const KINDS: IcalCapKind[] = ["vevents", "overrides", "rdates", "exdates"];

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the parse budget (wall clock, per listing)", () => {
  it("spent before the first object: nothing is read and the listing is truncated", async () => {
    const result = await occurrencesInWindow([ICLOUD_TIMED, UTC_WITH_DURATION], WINDOW, "UTC", {
      budgetMs: 0,
    });
    expect(result).toEqual({ occurrences: [], unreadable: 0, truncated: true });
  });

  const DAILY_SINCE_2010 = calendar(
    vevent("daily@budget", "DTSTART:20100101T080000Z", "DURATION:PT15M", "RRULE:FREQ=DAILY"),
  );

  it("is checked inside a series' walk: a long series stops when it runs out", async () => {
    let t = 0;
    const result = await occurrencesInWindow([DAILY_SINCE_2010], WINDOW, "UTC", {
      now: () => {
        t += 1;
        return t;
      },
      budgetMs: 1_000,
    });
    expect(result.truncated).toBe(true);
    expect(result.occurrences).toEqual([]);
  });

  it("with time to spare, the same series reaches the window and is not truncated", async () => {
    const result = await occurrencesInWindow([DAILY_SINCE_2010], WINDOW, "UTC", FROZEN);
    expect(result.truncated).toBe(false);
    expect(result.occurrences).toHaveLength(30);
  });

  it("yields to the event loop while it works, instead of blocking until the end", async () => {
    let t = 0;
    const order: string[] = [];
    setImmediate(() => order.push("other work"));
    const objects = Array.from({ length: 5 }, (_, n) =>
      calendar(vevent(`yield-${n}@budget`, "DTSTART:20261003T100000Z", "DURATION:PT1H")),
    );
    const result = await occurrencesInWindow(objects, WINDOW, "UTC", {
      now: () => {
        t += CALDAV_PARSE_SLICE_MS;
        return t;
      },
      budgetMs: Number.MAX_SAFE_INTEGER,
    });
    order.push("listing done");
    expect(result.occurrences).toHaveLength(5);
    expect(order).toEqual(["other work", "listing done"]);
  });
});

describe("caps per object", () => {
  it.each(
    KINDS,
  )("an object over the %s cap is skipped and the listing truncated; the rest is read", async (kind) => {
    const over = objectWith(kind, CALDAV_MAX_PER_OBJECT[kind] + 1, "over");
    const result = await occurrencesInWindow([over, ICLOUD_TIMED], WINDOW, "UTC", FROZEN);
    expect(result.truncated).toBe(true);
    expect(result.unreadable).toBe(0);
    expect(idsOf(result)).toEqual(["7A1C0F2E-0001-4B7E-9E1A-EXAMPLE00001"]);
  });

  it.each(KINDS)("an object exactly at the %s cap is read", async (kind) => {
    const at = objectWith(kind, CALDAV_MAX_PER_OBJECT[kind], "at");
    const result = await occurrencesInWindow([at], WINDOW, "UTC", FROZEN);
    expect(result.truncated).toBe(false);
    expect(idsOf(result)).toContain("at@cap");
  });

  it("several objects over a cap are warned about once per listing", async () => {
    const objects = [1, 2, 3].map((n) =>
      objectWith("vevents", CALDAV_MAX_PER_OBJECT.vevents + 1, `over-${n}`),
    );
    const result = await occurrencesInWindow(objects, WINDOW, "UTC", FROZEN);
    expect(result.truncated).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("vevents");
  });
});

describe("caps per listing", () => {
  it.each(
    KINDS,
  )("once the listing's %s cap is reached, the object that would pass it is skipped", async (kind) => {
    const perObject = CALDAV_MAX_PER_OBJECT[kind];
    const fit = Math.floor(CALDAV_MAX_PER_LISTING[kind] / perObject);
    expect(fit * perObject).toBe(CALDAV_MAX_PER_LISTING[kind]);
    const full = Array.from({ length: fit }, (_, n) => objectWith(kind, perObject, `fit-${n}`));
    const result = await occurrencesInWindow(
      [...full, objectWith(kind, 1, "one-too-many")],
      WINDOW,
      "UTC",
      FROZEN,
    );
    expect(result.truncated).toBe(true);
    const ids = new Set(idsOf(result));
    expect(ids.has("fit-0@cap")).toBe(true);
    expect(ids.has(`fit-${fit - 1}@cap`)).toBe(true);
    expect(ids.has("one-too-many@cap")).toBe(false);
  });
});

describe("override instants are looked up in a sorted index", () => {
  const sorted = [100, 200, 300];
  it.each([
    [99, 0, false],
    [100, 0, true],
    [150, 50, true],
    [150, 49, false],
    [350, 50, true],
    [351, 50, false],
    [0, 99, false],
    [1, 99, true],
  ])("an instant at %d within %d: %s", (ms, radius, expected) => {
    expect(hasInstantNear(sorted, ms, radius)).toBe(expected);
  });

  it("no overrides: nothing is near", () => {
    expect(hasInstantNear([], 0, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  // The walk skips steps before the window unless an override is near: this one,
  // years before the window, moves its occurrence into it.
  it("an occurrence from years before the window, moved into it, is listed", async () => {
    const moved = calendar(
      vevent(
        "moved-from-past@idx",
        "DTSTART:20200106T090000Z",
        "DURATION:PT1H",
        "RRULE:FREQ=WEEKLY;COUNT=20",
      ),
      vevent(
        "moved-from-past@idx",
        "RECURRENCE-ID:20200113T090000Z",
        "DTSTART:20261007T090000Z",
        "DURATION:PT1H",
      ),
    );
    const result = await occurrencesInWindow([moved], WINDOW, "UTC", FROZEN);
    expect(result.occurrences.map((o) => [o.externalId, o.startTime?.toISOString()])).toEqual([
      ["moved-from-past@idx#20200113T090000Z", "2026-10-07T09:00:00.000Z"],
    ]);
  });
});

describe("the impossible-rule search bound", () => {
  // Feb 29 on a given weekday recurs every 28 years between 1901 and 2099:
  // 10 227 days, one search pass each for a DAILY rule. The bound fits that and
  // keeps an impossible rule's cost to one bounded search.
  it("fits the 28-year leap-weekday cycle and no more than a small margin", () => {
    expect(MAX_RECUR_SPINS_PER_STEP).toBeGreaterThanOrEqual(10_227);
    expect(MAX_RECUR_SPINS_PER_STEP).toBeLessThanOrEqual(12_000);
    expect(CALDAV_MAX_SERIES_ITERATIONS).toBeGreaterThan(1_000);
  });
});

describe("an override of an EXDATE'd instance (known behaviour, documented)", () => {
  // RFC 5545 does not say which wins. EXDATE removes the original instance, and
  // the override that would have moved it goes with it: Klorn shows nothing.
  it("in the window: the excluded instance stays excluded, its override is dropped", async () => {
    const object = calendar(
      vevent(
        "exdate-override@x",
        "DTSTART:20261005T100000Z",
        "DURATION:PT1H",
        "RRULE:FREQ=DAILY;COUNT=3",
        "EXDATE:20261006T100000Z",
      ),
      vevent(
        "exdate-override@x",
        "RECURRENCE-ID:20261006T100000Z",
        "DTSTART:20261006T150000Z",
        "DURATION:PT1H",
      ),
    );
    const result = await occurrencesInWindow([object], WINDOW, "UTC", FROZEN);
    expect(result.occurrences.map((o) => o.externalId)).toEqual([
      "exdate-override@x#20261005T100000Z",
      "exdate-override@x#20261007T100000Z",
    ]);
  });

  it("past the window: an excluded instance moved into the window is dropped too", async () => {
    const object = calendar(
      vevent(
        "exdate-later@x",
        "DTSTART:20261005T100000Z",
        "DURATION:PT1H",
        "RRULE:FREQ=WEEKLY;COUNT=8",
        "EXDATE:20261116T100000Z",
      ),
      vevent(
        "exdate-later@x",
        "RECURRENCE-ID:20261116T100000Z",
        "DTSTART:20261020T150000Z",
        "DURATION:PT1H",
      ),
    );
    const result = await occurrencesInWindow([object], WINDOW, "UTC", FROZEN);
    expect(result.occurrences.map((o) => o.externalId)).not.toContain(
      "exdate-later@x#20261116T100000Z",
    );
    expect(result.occurrences).toHaveLength(4);
  });
});
