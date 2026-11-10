import { describe, expect, it } from "vitest";
import {
  AUTO_TIME_ZONE,
  autoSyncTarget,
  isValidTimeZone,
  resolveDisplayTimeZone,
  timeZonePreferenceBody,
} from "../../../web/src/lib/time-zone";
import {
  COMMON_TIME_ZONES,
  filterTimeZones,
  utcOffsetLabel,
} from "../../../web/src/lib/time-zone-options";

describe("resolveDisplayTimeZone", () => {
  it("a saved manual zone wins over the device zone", () => {
    expect(
      resolveDisplayTimeZone({
        mode: "MANUAL",
        savedZone: "America/New_York",
        deviceZone: "Asia/Seoul",
      }),
    ).toBe("America/New_York");
  });

  it("with no saved choice (AUTO) the device zone is used, not UTC", () => {
    expect(
      resolveDisplayTimeZone({ mode: "AUTO", savedZone: "UTC", deviceZone: "Asia/Seoul" }),
    ).toBe("Asia/Seoul");
  });

  it("treats a missing mode (older API) as AUTO", () => {
    expect(resolveDisplayTimeZone({ savedZone: "UTC", deviceZone: "Asia/Seoul" })).toBe(
      "Asia/Seoul",
    );
  });

  it("follows the device when it moves (travel) in AUTO", () => {
    expect(
      resolveDisplayTimeZone({
        mode: "AUTO",
        savedZone: "Asia/Seoul",
        deviceZone: "America/Los_Angeles",
      }),
    ).toBe("America/Los_Angeles");
  });

  it("falls back to the stored zone when AUTO has no readable device zone", () => {
    expect(
      resolveDisplayTimeZone({ mode: "AUTO", savedZone: "Asia/Tokyo", deviceZone: null }),
    ).toBe("Asia/Tokyo");
  });

  it("falls back to the device zone when the manual zone is unreadable", () => {
    expect(
      resolveDisplayTimeZone({ mode: "MANUAL", savedZone: "Mars/Base", deviceZone: "Asia/Seoul" }),
    ).toBe("Asia/Seoul");
  });

  it("uses UTC only as the last resort", () => {
    expect(resolveDisplayTimeZone({ mode: "AUTO", savedZone: null, deviceZone: null })).toBe("UTC");
    expect(
      resolveDisplayTimeZone({ mode: "MANUAL", savedZone: "bogus", deviceZone: "bogus" }),
    ).toBe("UTC");
  });
});

describe("autoSyncTarget (persist the device zone to the account)", () => {
  it("persists the device zone when AUTO and the account holds a different one", () => {
    expect(autoSyncTarget({ mode: "AUTO", savedZone: "UTC", deviceZone: "Asia/Seoul" })).toBe(
      "Asia/Seoul",
    );
  });

  it("does nothing when the account already matches", () => {
    expect(
      autoSyncTarget({ mode: "AUTO", savedZone: "Asia/Seoul", deviceZone: "Asia/Seoul" }),
    ).toBeNull();
  });

  it("never overrides a manual choice", () => {
    expect(
      autoSyncTarget({ mode: "MANUAL", savedZone: "Europe/London", deviceZone: "Asia/Seoul" }),
    ).toBeNull();
  });

  it("does not persist a UTC device zone (unconfigured / headless browser)", () => {
    expect(autoSyncTarget({ mode: "AUTO", savedZone: "Asia/Seoul", deviceZone: "UTC" })).toBeNull();
    expect(
      autoSyncTarget({ mode: "AUTO", savedZone: "Asia/Seoul", deviceZone: "Etc/UTC" }),
    ).toBeNull();
  });

  it("does not persist an unreadable device zone", () => {
    expect(autoSyncTarget({ mode: "AUTO", savedZone: "Asia/Seoul", deviceZone: null })).toBeNull();
    expect(autoSyncTarget({ mode: "AUTO", savedZone: "Asia/Seoul", deviceZone: "x/y" })).toBeNull();
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA names and rejects junk and offsets", () => {
    expect(isValidTimeZone("Asia/Seoul")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
    expect(isValidTimeZone("+09:00")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
  });
});

describe("time zone picker options", () => {
  it("labels the current offset with a real minus sign and half hours", () => {
    const july = new Date("2026-07-01T12:00:00Z");
    const january = new Date("2026-01-15T12:00:00Z");
    expect(utcOffsetLabel("Asia/Seoul", july)).toBe("UTC+9");
    expect(utcOffsetLabel("America/Los_Angeles", july)).toBe("UTC−7");
    expect(utcOffsetLabel("America/Los_Angeles", january)).toBe("UTC−8");
    expect(utcOffsetLabel("Asia/Kolkata", july)).toBe("UTC+5:30");
    expect(utcOffsetLabel("UTC", july)).toBe("UTC");
  });

  it("every common zone is a valid IANA name with a label key", () => {
    expect(COMMON_TIME_ZONES.length).toBeGreaterThanOrEqual(12);
    for (const entry of COMMON_TIME_ZONES) {
      expect(isValidTimeZone(entry.zone)).toBe(true);
      expect(entry.labelKey).toMatch(/^settings\.tz\.zone\./);
    }
    const zones = COMMON_TIME_ZONES.map((entry) => entry.zone);
    for (const z of [
      "UTC",
      "America/Los_Angeles",
      "Asia/Seoul",
      "Asia/Shanghai",
      "Europe/London",
    ]) {
      expect(zones).toContain(z);
    }
  });

  it("filters by zone id and by label, case-insensitively, ignoring underscores", () => {
    const options = [
      { zone: "America/Los_Angeles", label: "Pacific Time — Los Angeles" },
      { zone: "Asia/Seoul", label: "Korea — Seoul" },
    ];
    expect(filterTimeZones(options, "los angeles").map((o) => o.zone)).toEqual([
      "America/Los_Angeles",
    ]);
    expect(filterTimeZones(options, "KOREA").map((o) => o.zone)).toEqual(["Asia/Seoul"]);
    expect(filterTimeZones(options, "  ")).toHaveLength(2);
    expect(filterTimeZones(options, "zzz")).toHaveLength(0);
  });
});

describe("timeZonePreferenceBody (Settings save)", () => {
  it("Automatic sends AUTO with the device zone so the server schedules in it", () => {
    expect(timeZonePreferenceBody(AUTO_TIME_ZONE, "Asia/Seoul")).toEqual({
      timezoneMode: "AUTO",
      timezone: "Asia/Seoul",
    });
  });

  it("Automatic on a UTC/unreadable device sends only the mode", () => {
    expect(timeZonePreferenceBody(AUTO_TIME_ZONE, "UTC")).toEqual({ timezoneMode: "AUTO" });
    expect(timeZonePreferenceBody(AUTO_TIME_ZONE, null)).toEqual({ timezoneMode: "AUTO" });
  });

  it("a picked zone is sent as MANUAL", () => {
    expect(timeZonePreferenceBody("America/Denver", "Asia/Seoul")).toEqual({
      timezoneMode: "MANUAL",
      timezone: "America/Denver",
    });
  });

  it("an invalid manual selection produces no body", () => {
    expect(timeZonePreferenceBody("Mars/Base", "Asia/Seoul")).toBeNull();
  });
});
