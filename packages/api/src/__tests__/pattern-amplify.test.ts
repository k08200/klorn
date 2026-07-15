import { describe, expect, it } from "vitest";
import { amplifiedPriority, MAX_AMPLIFIED_PRIORITY } from "../learning/pattern-learner.js";

// Regression tests for the stale attention-item priority amplifier. The old
// version (newPriority = item.priority + floor(ageDays * 3), cap 120) compounded
// each 6h run and slammed items to a 120 ceiling that violated the documented
// 0-100 range — letting stale items climb above every fresh item and dominate
// the PUSH queue (and, via the briefing bridge, the daily Top 3).
describe("amplifiedPriority", () => {
  it("never exceeds the documented 0-100 ceiling (was 120)", () => {
    expect(MAX_AMPLIFIED_PRIORITY).toBe(100);
    expect(amplifiedPriority(95, 100)).toBeLessThanOrEqual(100);
    // near the ceiling, a run that would push past 100 is clamped to 100
    expect(amplifiedPriority(98, 100)).toBe(100);
    // a legacy over-cap value (the old amplifier reached 120) is healed to 100
    expect(amplifiedPriority(120, 5)).toBe(100);
  });

  it("bounds a single run's rise so age cannot slam an item to the cap at once", () => {
    const before = 60;
    const after = amplifiedPriority(before, 100); // 100-day-old item
    expect(after).toBeGreaterThan(before); // still rises
    expect(after - before).toBeLessThanOrEqual(5); // but by a bounded nudge, not floor(100*3)=300
  });

  it("raises an aged item but never lowers priority", () => {
    expect(amplifiedPriority(50, 2)).toBeGreaterThan(50);
    expect(amplifiedPriority(80, 0)).toBeGreaterThanOrEqual(80);
  });

  it("is idempotent at the ceiling (no overflow on re-amplification)", () => {
    expect(amplifiedPriority(100, 50)).toBe(100);
  });
});
