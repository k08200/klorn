/**
 * suggestAlternativeSlots — team mode v2's pure core. Given the proposed
 * slot, MY busy intervals, and the SENDER's busy intervals, propose the
 * first slots where BOTH are free: forward from the proposal, half-hour
 * grid, business hours (09:00–18:00) in the user's time zone, weekdays
 * only, never the proposed slot itself.
 */

import { describe, expect, it } from "vitest";
import { suggestAlternativeSlots } from "../pim/slot-suggest.js";

const TZ = "Asia/Seoul";
// Tue 2026-08-25 15:00 KST (06:00Z).
const PROPOSED = { startTime: "2026-08-25T06:00:00Z", endTime: "2026-08-25T07:00:00Z" };

function slots(args: Partial<Parameters<typeof suggestAlternativeSlots>[0]> = {}) {
  return suggestAlternativeSlots({
    proposedStart: PROPOSED.startTime,
    proposedEnd: PROPOSED.endTime,
    myBusy: [],
    attendeeBusy: [],
    timeZone: TZ,
    ...args,
  });
}

describe("suggestAlternativeSlots", () => {
  it("suggests the next free half-hour slots after the proposal, never the proposal itself", () => {
    const out = slots();
    expect(out.length).toBe(3);
    // 15:30, 16:00, 16:30 KST — proposal (15:00) skipped.
    expect(out[0].startTime).toBe("2026-08-25T06:30:00.000Z");
    expect(out[1].startTime).toBe("2026-08-25T07:00:00.000Z");
    expect(out.every((s) => s.startTime !== PROPOSED.startTime)).toBe(true);
  });

  it("skips slots where I am busy", () => {
    // Busy 15:00–17:00 KST → first candidate that fits is 17:00–18:00.
    const out = slots({ myBusy: [{ start: "2026-08-25T06:00:00Z", end: "2026-08-25T08:00:00Z" }] });
    expect(out[0].startTime).toBe("2026-08-25T08:00:00.000Z");
  });

  it("skips slots where the ATTENDEE is busy — the whole point of team mode", () => {
    const out = slots({
      attendeeBusy: [{ start: "2026-08-25T06:00:00Z", end: "2026-08-25T08:00:00Z" }],
    });
    expect(out[0].startTime).toBe("2026-08-25T08:00:00.000Z");
  });

  it("keeps suggestions inside business hours and rolls to the next morning", () => {
    // Proposed Tue 17:30 KST (08:30Z): a 1h slot ending 18:30 breaks the
    // 18:00 ceiling, so the first fit is Wed 09:00 KST (00:00Z).
    const out = slots({
      proposedStart: "2026-08-25T08:30:00Z",
      proposedEnd: "2026-08-25T09:30:00Z",
    });
    expect(out[0].startTime).toBe("2026-08-26T00:00:00.000Z");
  });

  it("never lands on a weekend", () => {
    // Proposed Fri 2026-08-28 17:30 KST → Sat/Sun skipped → Mon 09:00 KST.
    const out = slots({
      proposedStart: "2026-08-28T08:30:00Z",
      proposedEnd: "2026-08-28T09:30:00Z",
    });
    expect(out[0].startTime).toBe("2026-08-31T00:00:00.000Z");
  });

  it("preserves the proposed duration (30-minute meeting stays 30 minutes)", () => {
    const out = slots({ proposedEnd: "2026-08-25T06:30:00Z" });
    const s = new Date(out[0].startTime).getTime();
    const e = new Date(out[0].endTime).getTime();
    expect(e - s).toBe(30 * 60 * 1000);
  });

  it("returns an empty list when nothing fits in the search window", () => {
    // Both busy for the entire 3-day window.
    const wall = [{ start: "2026-08-24T00:00:00Z", end: "2026-09-01T00:00:00Z" }];
    expect(slots({ myBusy: wall })).toEqual([]);
    expect(slots({ attendeeBusy: wall })).toEqual([]);
  });
});
