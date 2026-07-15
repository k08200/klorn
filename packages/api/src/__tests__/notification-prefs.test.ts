import { beforeEach, describe, expect, it, vi } from "vitest";

// db must be mocked before importing notification-prefs.ts so the module
// graph doesn't try to open a real DB connection during tests.
const mocks = vi.hoisted(() => ({
  automationConfigFindUnique: vi.fn(),
}));

vi.mock("../db.js", () => ({
  prisma: {
    automationConfig: { findUnique: mocks.automationConfigFindUnique },
  },
}));

import { evaluateNotificationGate } from "../notify/notification-prefs.js";

const NOON_UTC = new Date("2026-01-01T12:00:00Z");
const NIGHT_UTC = new Date("2026-01-01T02:00:00Z");

describe("evaluateNotificationGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls open (allows) when the user has no config row", async () => {
    mocks.automationConfigFindUnique.mockResolvedValue(null);
    expect(await evaluateNotificationGate("user-1", "meeting", NOON_UTC)).toEqual({
      allowed: true,
    });
  });

  it("blocks a disabled category with reason user_preferences", async () => {
    mocks.automationConfigFindUnique.mockResolvedValue({
      notifyMeeting: false,
      timezone: "UTC",
      quietHoursStart: null,
      quietHoursEnd: null,
    });
    expect(await evaluateNotificationGate("user-1", "meeting", NOON_UTC)).toEqual({
      allowed: false,
      reason: "user_preferences",
    });
  });

  it("blocks during quiet hours with reason quiet_hours", async () => {
    mocks.automationConfigFindUnique.mockResolvedValue({
      timezone: "UTC",
      quietHoursStart: "22:00",
      quietHoursEnd: "08:00",
    });
    expect(await evaluateNotificationGate("user-1", "meeting", NIGHT_UTC)).toEqual({
      allowed: false,
      reason: "quiet_hours",
    });
  });

  it("reports user_preferences when both category and quiet hours block", async () => {
    mocks.automationConfigFindUnique.mockResolvedValue({
      notifyMeeting: false,
      timezone: "UTC",
      quietHoursStart: "22:00",
      quietHoursEnd: "08:00",
    });
    expect(await evaluateNotificationGate("user-1", "meeting", NIGHT_UTC)).toEqual({
      allowed: false,
      reason: "user_preferences",
    });
  });

  it("allows an enabled category outside quiet hours", async () => {
    mocks.automationConfigFindUnique.mockResolvedValue({
      timezone: "UTC",
      quietHoursStart: "22:00",
      quietHoursEnd: "08:00",
    });
    expect(await evaluateNotificationGate("user-1", "meeting", NOON_UTC)).toEqual({
      allowed: true,
    });
  });

  it("always allows the system category regardless of preference flags", async () => {
    mocks.automationConfigFindUnique.mockResolvedValue({
      notifyMeeting: false,
      notifyTaskDue: false,
      timezone: "UTC",
      quietHoursStart: null,
      quietHoursEnd: null,
    });
    expect(await evaluateNotificationGate("user-1", "system", NOON_UTC)).toEqual({
      allowed: true,
    });
  });
});
