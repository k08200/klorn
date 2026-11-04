import { afterEach, describe, expect, it } from "vitest";
import { isJudgeV3ShadowEnabled, judgeV3ShadowMode } from "../judge/v3/flags.js";
import { collectFeatureFlags } from "../ops/feature-flags.js";

afterEach(() => {
  delete process.env.JUDGE_V3_SHADOW;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
});

describe("JUDGE_V3_SHADOW", () => {
  it("is off by default", () => {
    expect(judgeV3ShadowMode()).toBe("off");
    expect(isJudgeV3ShadowEnabled("u1")).toBe(false);
    expect(collectFeatureFlags({}).dynamic.JUDGE_V3_SHADOW).toBe(false);
  });

  it("on opens it to every user", () => {
    process.env.JUDGE_V3_SHADOW = "true";
    expect(isJudgeV3ShadowEnabled("anyone")).toBe(true);
    expect(collectFeatureFlags({ JUDGE_V3_SHADOW: "true" }).dynamic.JUDGE_V3_SHADOW).toBe(true);
  });

  it("cohort opens it only to the rollout cohort", () => {
    process.env.JUDGE_V3_SHADOW = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "founder-id, other";
    expect(isJudgeV3ShadowEnabled("founder-id")).toBe(true);
    expect(isJudgeV3ShadowEnabled("stranger")).toBe(false);
    expect(collectFeatureFlags({ JUDGE_V3_SHADOW: "cohort" }).dynamic.JUDGE_V3_SHADOW).toBe(true);
  });
});
