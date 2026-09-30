/**
 * Graph names the zone an event was created in (originalStartTimeZone) with a
 * Windows zone name, which Intl does not know. The table maps it to IANA so an
 * all-day event's date can be derived in that zone.
 */

import { describe, expect, it } from "vitest";
import { ianaZoneOf, WINDOWS_TO_IANA } from "../pim/calendar-providers/outlook-time-zones.js";

describe("ianaZoneOf", () => {
  it.each([
    ["Korea Standard Time", "Asia/Seoul"],
    ["Pacific Standard Time", "America/Los_Angeles"],
    ["Eastern Standard Time", "America/New_York"],
    ["GMT Standard Time", "Europe/London"],
    ["Tokyo Standard Time", "Asia/Tokyo"],
    ["India Standard Time", "Asia/Kolkata"],
    ["AUS Eastern Standard Time", "Australia/Sydney"],
    ["UTC", "Etc/UTC"],
  ])("maps the Windows name %s to %s", (windows, iana) => {
    expect(ianaZoneOf(windows)).toBe(iana);
  });

  it("passes an IANA name through", () => {
    expect(ianaZoneOf("Asia/Seoul")).toBe("Asia/Seoul");
    expect(ianaZoneOf("America/Los_Angeles")).toBe("America/Los_Angeles");
  });

  it.each([
    ["an unknown name", "Mars Standard Time"],
    ["a legacy custom zone", "tzone://Microsoft/Custom"],
    ["an empty string", ""],
    ["a prototype property name", "constructor"],
    ["null", null],
    ["undefined", undefined],
  ])("answers null for %s, never a guess", (_label, value) => {
    expect(ianaZoneOf(value)).toBeNull();
  });

  it("every IANA name in the table is one this runtime knows", () => {
    const unknown = Object.entries(WINDOWS_TO_IANA).filter(([, iana]) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: iana });
        return false;
      } catch {
        return true;
      }
    });
    expect(unknown).toEqual([]);
  });

  it("covers the zones users actually have: a sample of the table is present", () => {
    expect(Object.keys(WINDOWS_TO_IANA).length).toBeGreaterThan(100);
  });
});
