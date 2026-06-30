import { describe, expect, it } from "vitest";
import {
  isLocalTimeWithin,
  localDateKey,
  localDayOfWeek,
  localDayUtcRange,
  localMinuteOfDay,
  normalizeTimeZone,
} from "../time-zone.js";

describe("timezone helpers", () => {
  it("normalizes invalid timezones to the product default", () => {
    expect(normalizeTimeZone("not/a-zone")).toBe("Asia/Seoul");
    expect(normalizeTimeZone(null)).toBe("Asia/Seoul");
  });

  it("computes local date and minute in the selected timezone", () => {
    const now = new Date("2026-05-04T00:30:00.000Z");
    expect(localDateKey(now, "Asia/Seoul")).toBe("2026-05-04");
    expect(localMinuteOfDay(now, "Asia/Seoul")).toBe(9 * 60 + 30);
    expect(localDateKey(now, "America/Los_Angeles")).toBe("2026-05-03");
  });

  it("returns the UTC range for the user's local day", () => {
    const range = localDayUtcRange(new Date("2026-05-04T00:30:00.000Z"), "Asia/Seoul");
    expect(range.dateKey).toBe("2026-05-04");
    expect(range.gte.toISOString()).toBe("2026-05-03T15:00:00.000Z");
    expect(range.lt.toISOString()).toBe("2026-05-04T15:00:00.000Z");
  });

  it("computes day-of-week in the selected timezone", () => {
    // 00:30 UTC is Mon 09:30 in Seoul but still Sun 17:30 in LA (previous
    // calendar day), so the two zones report adjacent weekdays.
    const d = new Date("2026-05-04T00:30:00.000Z");
    const seoul = localDayOfWeek(d, "Asia/Seoul");
    const la = localDayOfWeek(d, "America/Los_Angeles");
    expect(seoul).toBe((la + 1) % 7);
    expect(seoul).toBeGreaterThanOrEqual(0);
    expect(seoul).toBeLessThanOrEqual(6);
  });

  it("fires only within the window after the top of the LOCAL hour", () => {
    // 09:00 UTC = 18:00 in Seoul (the default EOD hour).
    const at1800 = new Date("2026-05-04T09:00:00.000Z");
    const at1806 = new Date("2026-05-04T09:06:00.000Z");
    const at1805 = new Date("2026-05-04T09:05:00.000Z");
    expect(isLocalTimeWithin(at1800, "Asia/Seoul", 18)).toBe(true);
    expect(isLocalTimeWithin(at1805, "Asia/Seoul", 18)).toBe(true); // upper bound inclusive
    expect(isLocalTimeWithin(at1806, "Asia/Seoul", 18)).toBe(false); // 6 min past
    // Same instant is the WRONG hour in UTC (09:00) — proves it is tz-aware.
    expect(isLocalTimeWithin(at1800, "UTC", 18)).toBe(false);
    expect(isLocalTimeWithin(at1800, "UTC", 9)).toBe(true);
  });
});
