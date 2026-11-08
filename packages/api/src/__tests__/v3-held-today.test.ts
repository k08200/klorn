/**
 * Today's "Held back" read (founder design N2, 2026-11-08): the mail the daily
 * interrupt budget held today, still shown held. held-today.ts owns the day
 * boundary in the user's zone and the SQL predicate the QUEUE lane page adds
 * for `GET /api/email?tier=QUEUE&window=held`.
 */

import { describe, expect, it } from "vitest";
import { heldTodayCutoff, heldTodaySql, localDayStart } from "../judge/v3/held-today.js";
import { HELD_WINDOW_MS } from "../judge/v3/ranking.js";

function sqlText(sql: { strings: readonly string[] }): string {
  return sql.strings.join("?").replace(/\s+/g, " ");
}

describe("localDayStart", () => {
  it("is local midnight in the user's zone", () => {
    // 2026-11-08 09:30 in Seoul (UTC+9) began at 2026-11-07T15:00Z.
    const now = new Date("2026-11-08T00:30:00.000Z");
    expect(localDayStart(now, "Asia/Seoul").toISOString()).toBe("2026-11-07T15:00:00.000Z");
  });

  it("follows a clock change (New York, the day DST ends)", () => {
    const now = new Date("2026-11-01T20:00:00.000Z");
    // Midnight on 2026-11-01 was still EDT (UTC-4).
    expect(localDayStart(now, "America/New_York").toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });

  it("reads an unknown zone as UTC", () => {
    const now = new Date("2026-11-08T13:00:00.000Z");
    expect(localDayStart(now, "Not/AZone").toISOString()).toBe("2026-11-08T00:00:00.000Z");
  });
});

describe("heldTodayCutoff", () => {
  it("is the start of the user's day", () => {
    const now = new Date("2026-11-08T00:30:00.000Z");
    expect(heldTodayCutoff(now, "Asia/Seoul").toISOString()).toBe("2026-11-07T15:00:00.000Z");
  });

  it("never reaches past the held window (a hold older than it is no longer shown held)", () => {
    // Kiritimati is UTC+14: late in its day, local midnight is ~23h59m back.
    // A 25h day (clock change) would exceed the window; the window wins.
    const now = new Date("2026-11-08T09:59:00.000Z");
    const cutoff = heldTodayCutoff(now, "Pacific/Kiritimati");
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(now.getTime() - HELD_WINDOW_MS);
  });
});

describe("heldTodaySql", () => {
  it("keeps only items still shown held, held at or after the cutoff", () => {
    const cutoff = new Date("2026-11-07T15:00:00.000Z");
    const sql = heldTodaySql(cutoff);
    const text = sqlText(sql);
    expect(text).toContain(`a."heldAt" IS NOT NULL`);
    expect(text).toContain(`a."heldAt" >= (?::timestamptz AT TIME ZONE 'UTC')`);
    expect(text).toContain(`a."tier" = 'QUEUE'`);
    expect(text).toContain(`a."status" = 'OPEN'`);
    expect(text).toContain(`a."isManualOverride" = false`);
    expect(text).toContain(`a."agentTierSetAt" IS NULL`);
    expect(sql.values).toEqual([cutoff]);
  });
});
