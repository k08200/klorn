/**
 * JUDGE_V3_SHADOW (docs/design/attention-engine-v3.md §6, phase P2). OFF by
 * default. Accepts the rollout-cohort mode like the other per-user features:
 * "cohort" runs the shadow only for ROLLOUT_COHORT_USER_IDS (founder first).
 * Read per call, so a flip needs no redeploy. The shadow never changes the
 * lane a user sees; it adds one background LLM call per new mail.
 */

import { type FlagMode, featureOpenTo, flagMode } from "../../config.js";
import { judgeV3PolicyEnabled } from "../../ops/feature-flags.js";
import { POLICY_VERSION, POLICY_VERSIONS, type PolicyVersion } from "./policy.js";

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

export const JUDGE_V3_POLICY_VERSION_ENV = "JUDGE_V3_POLICY_VERSION";

/**
 * The policy version the live judge runs (JUDGE_V3_POLICY_VERSION, read per
 * call, so it needs no redeploy). Unset: POLICY_VERSION. "v3.0" rolls the v3.1
 * rule changes back while the policy stays on. An unknown value runs the
 * default.
 */
export function judgeV3LivePolicyVersion(env: NodeJS.ProcessEnv = process.env): PolicyVersion {
  const raw = env[JUDGE_V3_POLICY_VERSION_ENV]?.trim();
  return raw && (POLICY_VERSIONS as readonly string[]).includes(raw)
    ? (raw as PolicyVersion)
    : POLICY_VERSION;
}
