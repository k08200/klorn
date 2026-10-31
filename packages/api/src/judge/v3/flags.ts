/**
 * JUDGE_V3_SHADOW (docs/design/attention-engine-v3.md §6, phase P2). OFF by
 * default. Accepts the rollout-cohort mode like the other per-user features:
 * "cohort" runs the shadow only for ROLLOUT_COHORT_USER_IDS (founder first).
 * Read per call, so a flip needs no redeploy. The shadow never changes the
 * lane a user sees; it adds one background LLM call per new mail.
 */

import { type FlagMode, featureOpenTo, flagMode } from "../../config.js";

export const JUDGE_V3_SHADOW_FLAG = "JUDGE_V3_SHADOW";

export function judgeV3ShadowMode(): FlagMode {
  return flagMode(JUDGE_V3_SHADOW_FLAG);
}

export function isJudgeV3ShadowEnabled(userId: string): boolean {
  return featureOpenTo(userId, [JUDGE_V3_SHADOW_FLAG]);
}
