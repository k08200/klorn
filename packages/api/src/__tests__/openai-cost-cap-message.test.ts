import { describe, expect, it } from "vitest";
import {
  DAILY_COST_CAP_MESSAGE,
  DAILY_COST_CAP_UPGRADE_MESSAGE,
  dailyCostCapMessageFor,
} from "../llm/openai.js";

describe("dailyCostCapMessageFor", () => {
  it("nudges an upgrade when the FREE-tier cap tripped (paywall on, non-entitled)", () => {
    expect(dailyCostCapMessageFor(true)).toBe(DAILY_COST_CAP_UPGRADE_MESSAGE);
  });

  it("nudges BYOK when the normal cap tripped (paid user / paywall off)", () => {
    expect(dailyCostCapMessageFor(false)).toBe(DAILY_COST_CAP_MESSAGE);
  });

  it("upgrade message sells the upgrade and does not offer BYOK", () => {
    // Only a FREE user with the paywall on sees this message, and BYOK is
    // Pro-only then (routes/billing.ts refuses to store their key, and
    // llm-credentials.ts ignores one) — so "add your own API key" is a dead end.
    expect(DAILY_COST_CAP_UPGRADE_MESSAGE).toMatch(/upgrade/i);
    expect(DAILY_COST_CAP_UPGRADE_MESSAGE).not.toMatch(/api key/i);
  });

  it("BYOK message does not mention upgrading (paid users must not be upsold)", () => {
    expect(DAILY_COST_CAP_MESSAGE).not.toMatch(/upgrade/i);
  });
});
