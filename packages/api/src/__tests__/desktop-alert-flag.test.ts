import { beforeEach, describe, expect, it, vi } from "vitest";

// The `alert` tag on a real-time notification frame is what the Windows
// desktop shell turns into an OS banner (packages/web lib/native/
// desktop-alerts.ts). It must follow the SAME gate Web Push uses — category
// opt-out and quiet hours (notify/notification-prefs.ts) — so the desktop
// banner never fires where a web push would have been suppressed.
const gate = vi.hoisted(() => vi.fn());

vi.mock("../notify/notification-prefs.js", () => ({
  evaluateNotificationGate: gate,
}));

import { desktopAlertTag } from "../notify/desktop-alert.js";

describe("desktopAlertTag", () => {
  beforeEach(() => {
    gate.mockReset();
  });

  it("tags PUSH mail when the email_urgent category is allowed", async () => {
    gate.mockResolvedValue({ allowed: true });
    await expect(desktopAlertTag("u1", "push")).resolves.toEqual({ alert: "push" });
    expect(gate).toHaveBeenCalledWith("u1", "email_urgent");
  });

  it("tags a meeting when the meeting category is allowed", async () => {
    gate.mockResolvedValue({ allowed: true });
    await expect(desktopAlertTag("u1", "meeting")).resolves.toEqual({ alert: "meeting" });
    expect(gate).toHaveBeenCalledWith("u1", "meeting");
  });

  it("omits the tag when the user opted out of the category", async () => {
    gate.mockResolvedValue({ allowed: false, reason: "user_preferences" });
    await expect(desktopAlertTag("u1", "push")).resolves.toEqual({});
  });

  it("omits the tag inside quiet hours", async () => {
    gate.mockResolvedValue({ allowed: false, reason: "quiet_hours" });
    await expect(desktopAlertTag("u1", "meeting")).resolves.toEqual({});
  });

  it("fails closed (no banner, bell row still delivered) when the gate lookup throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    gate.mockRejectedValue(new Error("db down"));
    await expect(desktopAlertTag("u1", "push")).resolves.toEqual({});
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
