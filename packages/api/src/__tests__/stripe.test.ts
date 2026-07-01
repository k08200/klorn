import { afterEach, describe, expect, it, vi } from "vitest";
import { getEffectivePlan, PLANS, planHasFeature } from "../stripe.js";

describe("plan device limits", () => {
  it("gives free accounts a single device (no free tier — locked at launch)", () => {
    expect(PLANS.FREE.deviceLimit).toBe(1);
  });

  it("gives Pro a small multi-device allowance above Free", () => {
    expect(PLANS.PRO.deviceLimit).toBe(3);
    expect(PLANS.PRO.deviceLimit).toBeGreaterThan(PLANS.FREE.deviceLimit);
    expect(PLANS.TEAM.deviceLimit).toBeGreaterThanOrEqual(PLANS.PRO.deviceLimit);
  });

  it("gives admins unlimited device sessions", () => {
    expect(getEffectivePlan("FREE", "ADMIN").deviceLimit).toBe(Infinity);
  });

  // NOTE: this file is imported at the top level with PAYWALL_ENABLED unset, so
  // these assertions cover the paywall-OFF (pre-launch) FREE_FEATURES branch.
  // The paywall-ON FREE_TASTER set is covered separately below via resetModules.
  it("keeps the beta trust loop available on free accounts (paywall OFF branch)", () => {
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

// With the paywall ON, FREE becomes the usable free tier (the taster set) — not
// an empty subscriber-only wall. These re-import the module with
// PAYWALL_ENABLED=true so the FREE_TASTER branch is active.
describe("free tier under the paywall (PAYWALL_ENABLED=true)", () => {
  const ORIGINAL_PAYWALL = process.env.PAYWALL_ENABLED;

  afterEach(() => {
    if (ORIGINAL_PAYWALL === undefined) {
      delete process.env.PAYWALL_ENABLED;
    } else {
      process.env.PAYWALL_ENABLED = ORIGINAL_PAYWALL;
    }
    vi.resetModules();
  });

  const loadPaywalled = async () => {
    process.env.PAYWALL_ENABLED = "true";
    vi.resetModules();
    return import("../stripe.js");
  };

  it("grants FREE the core firewall taster: read + classify + briefing + AUTO", async () => {
    const { planHasFeature: has } = await loadPaywalled();
    expect(has("FREE", "email_read")).toBe(true);
    expect(has("FREE", "email_auto_classify")).toBe(true);
    expect(has("FREE", "daily_briefing")).toBe(true);
    expect(has("FREE", "autonomous_agent")).toBe(true);
    expect(has("FREE", "agent_mode_auto")).toBe(true);
    expect(has("FREE", "calendar_read")).toBe(true);
  });

  it("keeps sending, replies, learning, and integrations Pro-only", async () => {
    const { planHasFeature: has } = await loadPaywalled();
    expect(has("FREE", "email_write")).toBe(false);
    expect(has("FREE", "email_auto_reply")).toBe(false);
    expect(has("FREE", "pattern_learning")).toBe(false);
    expect(has("FREE", "calendar_create")).toBe(false);
    expect(has("FREE", "calendar_write")).toBe(false);
    expect(has("FREE", "slack")).toBe(false);
    expect(has("FREE", "notion")).toBe(false);
    expect(has("FREE", "web_search")).toBe(false);
    expect(has("FREE", "meeting_tools")).toBe(false);
    // Multi-account (a second inbox / secondary account) is a paid differentiator.
    expect(has("FREE", "multi_account")).toBe(false);
  });

  it("grants multi-account to every paid plan (Pro/Team/Enterprise)", async () => {
    const { planHasFeature: has } = await loadPaywalled();
    expect(has("PRO", "multi_account")).toBe(true);
    expect(has("TEAM", "multi_account")).toBe(true);
    expect(has("ENTERPRISE", "multi_account")).toBe(true);
    // ADMIN bypass still covers it for founder dogfooding.
    expect(has("FREE", "multi_account", "ADMIN")).toBe(true);
  });

  it("does not hard-wall free users on entry (usable free tier)", async () => {
    const { isHardPaywalled, isEntitled } = await loadPaywalled();
    // Free is not entitled to paid features...
    expect(isEntitled("FREE", "USER")).toBe(false);
    // ...but is NOT hard-walled — they get into the app.
    expect(isHardPaywalled("FREE", "USER")).toBe(false);
  });

  it("never hard-walls entitled users or admins", async () => {
    const { isHardPaywalled } = await loadPaywalled();
    expect(isHardPaywalled("PRO", "USER")).toBe(false);
    expect(isHardPaywalled("FREE", "ADMIN")).toBe(false);
  });
});
