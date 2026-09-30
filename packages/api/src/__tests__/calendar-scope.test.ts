/**
 * C2 kill switch: while LINKED_CALENDAR_SYNC_ENABLED is off, every reader
 * excludes linked rows (sourceAccountId NULL only), so turning the flag off
 * hides rows already synced immediately instead of leaving them on screen.
 */

import { afterEach, describe, expect, it } from "vitest";
import { calendarSourceScope, isCalendarRowVisible } from "../pim/calendar-scope.js";

const KEY = "LINKED_CALENDAR_SYNC_ENABLED";
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe("calendarSourceScope", () => {
  it("limits a where clause to primary and LOCAL rows while the flag is off", () => {
    delete process.env[KEY];
    expect(calendarSourceScope()).toEqual({ sourceAccountId: null });
    process.env[KEY] = "false";
    expect(calendarSourceScope()).toEqual({ sourceAccountId: null });
  });

  it("adds nothing once the flag is on", () => {
    process.env[KEY] = "true";
    expect(calendarSourceScope()).toEqual({});
  });

  it("is read at request time: a flip needs no restart", () => {
    process.env[KEY] = "true";
    expect(calendarSourceScope()).toEqual({});
    process.env[KEY] = "off";
    expect(calendarSourceScope()).toEqual({ sourceAccountId: null });
  });

  it("returns a fresh object each call so a caller cannot poison the next query", () => {
    delete process.env[KEY];
    const first = calendarSourceScope() as { sourceAccountId?: unknown };
    first.sourceAccountId = "x";
    expect(calendarSourceScope()).toEqual({ sourceAccountId: null });
  });
});

describe("isCalendarRowVisible", () => {
  it("hides a linked row while the flag is off, shows it once on", () => {
    delete process.env[KEY];
    expect(isCalendarRowVisible({ sourceAccountId: "acct-1" })).toBe(false);
    process.env[KEY] = "true";
    expect(isCalendarRowVisible({ sourceAccountId: "acct-1" })).toBe(true);
  });

  it("always shows primary and LOCAL rows, whatever the flag", () => {
    delete process.env[KEY];
    expect(isCalendarRowVisible({ sourceAccountId: null })).toBe(true);
    expect(isCalendarRowVisible({})).toBe(true);
    process.env[KEY] = "true";
    expect(isCalendarRowVisible({ sourceAccountId: null })).toBe(true);
  });
});
