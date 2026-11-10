/**
 * Day shape — deterministic segment/curve math behind briefing v2. The LLM
 * words segments; it must never decide them, so this math carries the tests.
 */

import { describe, expect, it } from "vitest";
import { buildDayShape, DAY_END_HOUR, DAY_START_HOUR, localHour } from "../pim/day-shape.js";

describe("localHour", () => {
  it("converts an instant to fractional hours in the given timezone", () => {
    // 2026-08-22T00:30Z = 09:30 KST
    expect(localHour(new Date("2026-08-22T00:30:00Z"), "Asia/Seoul")).toBe(9.5);
    expect(localHour(new Date("2026-08-22T00:30:00Z"), "UTC")).toBe(0.5);
  });
});

describe("buildDayShape", () => {
  it("splits a morning-heavy day into busy → free (the Kim screenshot shape)", () => {
    const shape = buildDayShape([
      { title: "Sync", startHour: 9, endHour: 9.5 },
      { title: "Weekly", startHour: 9.5, endHour: 10 },
      { title: "Vendor check-in", startHour: 8.5, endHour: 9 },
    ]);
    expect(shape.segments).toHaveLength(2);
    expect(shape.segments[0]).toMatchObject({
      startHour: DAY_START_HOUR,
      endHour: 10,
      kind: "busy",
    });
    expect(shape.segments[0].eventTitles).toEqual(["Vendor check-in", "Sync", "Weekly"]);
    expect(shape.segments[1]).toMatchObject({ endHour: DAY_END_HOUR, kind: "free" });
    expect(shape.meetingCount).toBe(3);
  });

  it("produces three segments for a split day (morning + late-afternoon)", () => {
    const shape = buildDayShape([
      { title: "Standup", startHour: 9, endHour: 10 },
      { title: "Partner call", startHour: 15, endHour: 16 },
    ]);
    expect(shape.segments.map((s) => s.kind)).toEqual(["busy", "free", "busy"]);
    expect(shape.segments[1]).toMatchObject({ startHour: 10, endHour: 15 });
    expect(shape.segments[2].eventTitles).toEqual(["Partner call"]);
  });

  it("marks an empty weekend as off and an empty weekday as free", () => {
    expect(buildDayShape([], true).segments).toEqual([
      { startHour: DAY_START_HOUR, endHour: DAY_END_HOUR, kind: "off", eventTitles: [] },
    ]);
    expect(buildDayShape([], false).segments[0].kind).toBe("free");
  });

  it("builds an hourly overlap curve clipped to the day window", () => {
    const shape = buildDayShape([
      { title: "Early", startHour: 6, endHour: 9 }, // clipped to 8-9
      { title: "Overlap", startHour: 8, endHour: 10 },
    ]);
    expect(shape.curve[0]).toBe(2); // 08h: both
    expect(shape.curve[1]).toBe(1); // 09h: Overlap only
    expect(shape.curve[2]).toBe(0);
    expect(shape.curve).toHaveLength(DAY_END_HOUR - DAY_START_HOUR);
    expect(shape.freeHours).toBe(10);
  });

  it("merges a free morning into one leading free segment", () => {
    const shape = buildDayShape([{ title: "Late call", startHour: 17, endHour: 18 }]);
    expect(shape.segments.map((s) => s.kind)).toEqual(["free", "busy", "free"]);
    expect(shape.segments[0]).toMatchObject({ startHour: DAY_START_HOUR, endHour: 17 });
  });
});
