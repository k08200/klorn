import { describe, expect, it } from "vitest";
import { isUserIdleForAgent } from "../agent-idle.js";

const NOW = Date.UTC(2026, 4, 25, 13, 0, 0);
const HOUR = 60 * 60 * 1000;

describe("isUserIdleForAgent", () => {
  it("treats a user with no device activity as idle", () => {
    expect(isUserIdleForAgent(null, { now: NOW })).toBe(true);
    expect(isUserIdleForAgent(undefined, { now: NOW })).toBe(true);
  });

  it("allows a user whose last device activity is within the threshold", () => {
    const lastActive = new Date(NOW - 1 * HOUR);
    expect(isUserIdleForAgent(lastActive, { now: NOW, thresholdMs: 24 * HOUR })).toBe(false);
  });

  it("skips a user whose last device activity is just past the threshold", () => {
    const lastActive = new Date(NOW - 25 * HOUR);
    expect(isUserIdleForAgent(lastActive, { now: NOW, thresholdMs: 24 * HOUR })).toBe(true);
  });

  it("treats activity exactly at the threshold as still active (not idle)", () => {
    const lastActive = new Date(NOW - 24 * HOUR);
    expect(isUserIdleForAgent(lastActive, { now: NOW, thresholdMs: 24 * HOUR })).toBe(false);
  });

  it("uses the configured default threshold when caller omits it", () => {
    // Default is 24h; verify we read it rather than hard-coding inside the helper
    const lastActive = new Date(NOW - 26 * HOUR);
    expect(isUserIdleForAgent(lastActive, { now: NOW })).toBe(true);
  });
});
