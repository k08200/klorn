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
    ["India Standard Time", "Asia/Calcutta"],
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

  it("has exactly the 139 territory-001 rows of CLDR's windowsZones.xml, so a change to the table is deliberate", () => {
    expect(Object.keys(WINDOWS_TO_IANA)).toHaveLength(139);
  });
});

// Probes chosen so that zones with different rules diverge (Almaty moved from +06 to
// +05 in 2024, Bishkek did not) while an IANA alias of the same zone does not.
const PROBES = [
  Date.UTC(1990, 0, 15, 12),
  Date.UTC(2010, 6, 15, 12),
  Date.UTC(2026, 0, 15, 12),
  Date.UTC(2026, 6, 15, 12),
];

function wallClocks(zone: string): string {
  return PROBES.map((t) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(t),
  ).join("|");
}

/** The same zone, whatever alias spells it: compared by what it shows, not by its name. */
function sameZone(a: string, b: string): boolean {
  return wallClocks(a) === wallClocks(b);
}

describe("pinned against CLDR common/supplemental/windowsZones.xml (territory 001)", () => {
  // Values are what CLDR (unicode-org/cldr c33a1f0a, TZDB 2025b) says for each name.
  // These are the pairings memory got wrong, or that CLDR spells unexpectedly.
  it.each([
    ["Korea Standard Time", "Asia/Seoul"],
    ["Pacific Standard Time", "America/Los_Angeles"],
    ["India Standard Time", "Asia/Calcutta"],
    ["China Standard Time", "Asia/Shanghai"],
    ["Central Asia Standard Time", "Asia/Bishkek"],
    ["US Eastern Standard Time", "America/Indianapolis"],
    ["FLE Standard Time", "Europe/Kiev"],
    ["South Sudan Standard Time", "Africa/Juba"],
    ["Russia Time Zone 11", "Asia/Kamchatka"],
  ])("%s is the zone CLDR names, %s", (windows, cldr) => {
    const zone = ianaZoneOf(windows);

    expect(zone).not.toBeNull();
    expect(sameZone(zone ?? "", cldr)).toBe(true);
  });

  it("the comparison can tell the zone CLDR names from the one it replaced for Central Asia", () => {
    expect(sameZone("Asia/Almaty", "Asia/Bishkek")).toBe(false);
    expect(sameZone("Asia/Kolkata", "Asia/Calcutta")).toBe(true);
  });

  it("a Windows name CLDR does not list is not guessed", () => {
    expect(ianaZoneOf("Kamchatka Standard Time")).toBeNull();
  });
});
