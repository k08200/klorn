import { describe, expect, it } from "vitest";
import {
  DAILY_COST_CAP_MESSAGE,
  DAILY_COST_CAP_UPGRADE_MESSAGE,
  dailyCostCapMessageFor,
} from "../openai.js";

describe("dailyCostCapMessageFor", () => {
  it("nudges an upgrade when the FREE-tier cap tripped (paywall on, non-entitled)", () => {
    expect(dailyCostCapMessageFor(true)).toBe(DAILY_COST_CAP_UPGRADE_MESSAGE);
  });

  it("nudges BYOK when the normal cap tripped (paid user / paywall off)", () => {
    expect(dailyCostCapMessageFor(false)).toBe(DAILY_COST_CAP_MESSAGE);
  });

  it("upgrade message actually sells the upgrade, and keeps BYOK as the fallback", () => {
    expect(DAILY_COST_CAP_UPGRADE_MESSAGE).toMatch(/upgrade/i);
    expect(DAILY_COST_CAP_UPGRADE_MESSAGE).toMatch(/api key/i);
  });

  it("BYOK message does not mention upgrading (paid users must not be upsold)", () => {
    expect(DAILY_COST_CAP_MESSAGE).not.toMatch(/upgrade/i);
  });
});
