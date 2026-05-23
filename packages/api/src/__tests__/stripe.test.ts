import { describe, expect, it } from "vitest";
import { getEffectivePlan, PLANS, planHasFeature } from "../stripe.js";

describe("plan device limits", () => {
  it("allows free users to stay signed in on phone and desktop at the same time", () => {
    expect(PLANS.FREE.deviceLimit).toBeGreaterThanOrEqual(2);
  });

  it("keeps higher plans at or above the free device allowance", () => {
    expect(PLANS.PRO.deviceLimit).toBeGreaterThanOrEqual(PLANS.FREE.deviceLimit);
    expect(PLANS.TEAM.deviceLimit).toBeGreaterThanOrEqual(PLANS.PRO.deviceLimit);
  });

  it("gives admins unlimited device sessions", () => {
    expect(getEffectivePlan("FREE", "ADMIN").deviceLimit).toBe(Infinity);
  });

  it("keeps the beta trust loop available on free accounts", () => {
    expect(planHasFeature("FREE", "daily_briefing")).toBe(true);
    expect(planHasFeature("FREE", "email_auto_classify")).toBe(true);
    expect(planHasFeature("FREE", "autonomous_agent")).toBe(true);
    expect(planHasFeature("FREE", "pattern_learning")).toBe(true);
    expect(planHasFeature("FREE", "calendar_create")).toBe(true);
    expect(planHasFeature("FREE", "calendar_write")).toBe(false);
    expect(planHasFeature("FREE", "email_write")).toBe(false);
    expect(planHasFeature("FREE", "email_auto_reply")).toBe(false);
    expect(planHasFeature("FREE", "agent_mode_auto")).toBe(false);
  });

  it("keeps calendar event creation available on every paid plan", () => {
    for (const plan of ["PRO", "TEAM", "ENTERPRISE"]) {
      expect(planHasFeature(plan, "calendar_create")).toBe(true);
      expect(planHasFeature(plan, "calendar_write")).toBe(true);
    }
  });
});
