/**
 * JUDGE_V3_SHADOW (docs/design/attention-engine-v3.md §6, phase P2). OFF by
 * default. Accepts the rollout-cohort mode like the other per-user features:
 * "cohort" runs the shadow only for ROLLOUT_COHORT_USER_IDS (founder first).
 * Read per call, so a flip needs no redeploy. The shadow never changes the
 * lane a user sees; it adds one background LLM call per new mail.
 */

import { type FlagMode, featureOpenTo, flagMode } from "../../config.js";
import { judgeV3PolicyEnabled } from "../../ops/feature-flags.js";

export const JUDGE_V3_SHADOW_FLAG = "JUDGE_V3_SHADOW";

export function judgeV3ShadowMode(): FlagMode {
  return flagMode(JUDGE_V3_SHADOW_FLAG);
}

export function isJudgeV3ShadowEnabled(userId: string): boolean {
  return featureOpenTo(userId, [JUDGE_V3_SHADOW_FLAG]);
}

/**
 * Whether policy v3 decides this user's lanes (doc §3(5) "Flags"):
 * JUDGE_V3_POLICY on, and the user covered by JUDGE_V3_SHADOW (everyone, or
 * the cohort). Everyone else keeps v2 exactly, with no interrupt budget.
 */
export function isJudgeV3PolicyEnabled(userId: string): boolean {
  return judgeV3PolicyEnabled() && isJudgeV3ShadowEnabled(userId);
}
