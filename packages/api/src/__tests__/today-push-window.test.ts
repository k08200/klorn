/**
 * Today's "Needs you now" window (founder decision, 2026-10-23): the Today
 * PUSH block lists only PUSH mail received in the last 72 hours. Older PUSH
 * stays in the Mail lane views untouched. The window is a mail's receivedAt;
 * an item with no received time (no mail behind it) falls back to its createdAt.
 */

import { describe, expect, it } from "vitest";
import {
  isInTodayPushWindow,
  TODAY_PUSH_WINDOW_HOURS,
  todayPushCutoff,
} from "../judge/today-push-window.js";

const NOW = new Date("2026-10-23T12:00:00.000Z");
const MINUTE_MS = 60_000;
const ago = (hours: number, minutes = 0) =>
  new Date(NOW.getTime() - (hours * 60 + minutes) * MINUTE_MS);

describe("Today PUSH window", () => {
  it("is 72 hours", () => {
    expect(TODAY_PUSH_WINDOW_HOURS).toBe(72);
    expect(todayPushCutoff(NOW).toISOString()).toBe("2026-10-20T12:00:00.000Z");
  });

  it("keeps mail received 71h59m ago", () => {
    expect(isInTodayPushWindow(ago(71, 59), ago(200), NOW)).toBe(true);
  });

  it("keeps mail received exactly at the cutoff", () => {
    expect(isInTodayPushWindow(ago(72), ago(200), NOW)).toBe(true);
  });

  it("drops mail received 72h01m ago", () => {
    expect(isInTodayPushWindow(ago(72, 1), ago(1), NOW)).toBe(false);
  });

  it("accepts ISO strings (the wire shape)", () => {
    expect(isInTodayPushWindow(ago(1).toISOString(), ago(200).toISOString(), NOW)).toBe(true);
  });

  it("falls back to createdAt only when receivedAt is null", () => {
    expect(isInTodayPushWindow(null, ago(71, 59), NOW)).toBe(true);
    expect(isInTodayPushWindow(null, ago(72, 1), NOW)).toBe(false);
    expect(isInTodayPushWindow(undefined, ago(2), NOW)).toBe(true);
  });

  it("treats an unparseable time as outside the window", () => {
    expect(isInTodayPushWindow("not-a-date", "also-not", NOW)).toBe(false);
  });
});
