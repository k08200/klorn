import { afterEach, describe, expect, it, vi } from "vitest";

// PAYWALL_ENABLED is read once at module load (config.ts), so each case stubs
// the env and re-imports stripe.ts with a fresh module graph.
describe("paywall entitlement (stripe.ts)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("paywall OFF (default): FREE keeps its taster features and everyone is entitled", async () => {
    vi.stubEnv("PAYWALL_ENABLED", "");
    vi.resetModules();
    const { planHasFeature, isEntitled } = await import("../stripe.js");

    // FREE keeps the historical taster set — nothing changes pre-launch.
    expect(planHasFeature("FREE", "email_auto_classify")).toBe(true);
    expect(planHasFeature("FREE", "daily_briefing")).toBe(true);
    // Paid-only features are still gated even with the paywall off.
    expect(planHasFeature("FREE", "email_write")).toBe(false);
    // Entitlement is open to all when the paywall is off (no gating yet).
    expect(isEntitled("FREE")).toBe(true);
    expect(isEntitled("PRO")).toBe(true);
  });

  it("paywall ON: FREE gets the usable taster tier; only paid/admin are entitled", async () => {
    vi.stubEnv("PAYWALL_ENABLED", "true");
    vi.resetModules();
    const { planHasFeature, isEntitled, isHardPaywalled } = await import("../stripe.js");

    // Usable free tier — the core firewall experience stays on for FREE
    // (bounded by the free daily cost cap, not by feature removal).
    expect(planHasFeature("FREE", "email_auto_classify")).toBe(true);
    expect(planHasFeature("FREE", "daily_briefing")).toBe(true);
    expect(planHasFeature("FREE", "email_read")).toBe(true);
    expect(planHasFeature("FREE", "agent_mode_auto")).toBe(true);
    // Pro-only value stays gated for FREE: sending, replies, learning.
    expect(planHasFeature("FREE", "email_write")).toBe(false);
    expect(planHasFeature("FREE", "email_auto_reply")).toBe(false);
    expect(planHasFeature("FREE", "pattern_learning")).toBe(false);
    // Paid plan still has everything.
    expect(planHasFeature("PRO", "email_auto_classify")).toBe(true);
    // ADMIN bypass survives (founder dogfooding / comped admin).
    expect(planHasFeature("FREE", "email_write", "ADMIN")).toBe(true);

    // Entitlement (paid features): FREE is out; paid + admin (comp) are in.
    expect(isEntitled("FREE")).toBe(false);
    expect(isEntitled("PRO")).toBe(true);
    expect(isEntitled("TEAM")).toBe(true);
    expect(isEntitled("ENTERPRISE")).toBe(true);
    expect(isEntitled("FREE", "ADMIN")).toBe(true);

    // But FREE is NOT hard-walled out of the app — usable free tier.
    expect(isHardPaywalled("FREE")).toBe(false);
    expect(isHardPaywalled("PRO")).toBe(false);
    expect(isHardPaywalled("FREE", "ADMIN")).toBe(false);
  });
});
