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
  hasExplicitOffset,
  naiveLocalToUtc,
  parseGoogleDateTime,
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
