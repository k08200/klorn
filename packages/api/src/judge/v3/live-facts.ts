/**
 * The live facts path (docs/design/attention-engine-v3.md §3(5), JUDGE_V3_POLICY).
 * With the policy on for a user, the facts call is part of the judge, so it does
 * not behave like the sampled shadow:
 *  - it waits for its pacer/RPM slot like the v2 judge (no noWait);
 *  - it draws on the judge's reserved budget and the user's own credentials
 *    (BYOK included), with no shadow slot or spend caps;
 *  - it stores the AttentionFacts row (v2 lane frozen) before answering "ok";
 *  - at the deadline it answers "timeout" and lets the call finish and store
 *    in the background, so replay still gets the row.
 * It never throws. The caller (policy, P3) decides the lane: "ok" AND
 * extraction.source === "llm" → v3; anything else ("ok" with source "none",
 * timeout, budget, error) → the v2 lane, exactly as without the policy.
 *
 * New mail only: a re-judge or backfill reads the stored row and never calls
 * the model again (it would spend the judge reserve twice). Past the deadline
 * the call is not retried, so an answer nobody waits for costs one call at most.
 */

import { isDataWipeFenceError } from "../../privacy/data-wipe-fence.js";
import type { ProviderCredentials } from "../../providers/index.js";
import { captureError } from "../../sentry.js";
import type { PocTier } from "../poc-judge.js";
import type { FactsExtraction } from "./facts-extractor.js";
import type { RelationshipSnapshot } from "./relationship.js";
import {
  buildFactsMailInput,
  prismaShadowDeps,
  type ShadowDeps,
  type ShadowMail,
} from "./shadow.js";

export type LiveFactsResult =
  | { status: "ok"; extraction: FactsExtraction; relationship: RelationshipSnapshot | null }
  | { status: "timeout" | "budget" | "error" };

export interface LiveFactsOptions {
  v2Tier: PocTier;
  credentials?: ProviderCredentials;
  deadlineMs: number;
}

export type LiveFactsDeps = Pick<
  ShadowDeps,
  "userContext" | "repliedAfter" | "extract" | "relationship" | "save" | "now"
>;

export const prismaLiveFactsDeps: LiveFactsDeps = {
  userContext: prismaShadowDeps.userContext,
  repliedAfter: prismaShadowDeps.repliedAfter,
  extract: prismaShadowDeps.extract,
  relationship: prismaShadowDeps.relationship,
  save: prismaShadowDeps.save,
  now: prismaShadowDeps.now,
};

const BUDGET_ERRORS = new Set(["DailyCostCapExceededError", "UserRateLimitedError"]);

async function extractAndStore(
  userId: string,
  mail: ShadowMail,
  opts: LiveFactsOptions,
  deps: LiveFactsDeps,
  abandoned: () => boolean,
): Promise<LiveFactsResult> {
  const { input, userAddresses } = await buildFactsMailInput(userId, mail, deps);
  const extraction = await deps.extract(input, {
    userId,
    reserved: true,
    abandoned,
    ...(opts.credentials ? { credentials: opts.credentials } : {}),
  });
  const relationship = await deps.relationship(
    userId,
    mail.from,
    userAddresses,
    mail.senderAuthenticated,
    mail.emailId,
  );
  await deps.save({
    userId,
    source: "EMAIL",
    sourceId: mail.emailId,
    extraction,
    relationship,
    v2Tier: opts.v2Tier,
    extractedAt: deps.now(),
  });
  return { status: "ok", extraction, relationship };
}

/** Never rejects: budget refusals → "budget", anything else → "error" (name only to Sentry). */
async function settle(work: () => Promise<LiveFactsResult>, userId: string, emailId: string) {
  try {
    return await work();
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    if (BUDGET_ERRORS.has(name)) return { status: "budget" } as const;
    // A data wipe in progress rejected the write: expected, not an incident.
    if (isDataWipeFenceError(err)) return { status: "error" } as const;
    console.warn("[judge-v3] live facts failed:", name);
    captureError(new Error(`judge-v3 live facts failed: ${name}`), {
      tags: { scope: "judge-v3-live-facts" },
      extra: { userId, emailId },
    });
    return { status: "error" } as const;
  }
}

export async function extractFactsForDecision(
  userId: string,
  mail: ShadowMail,
  opts: LiveFactsOptions,
  deps: LiveFactsDeps = prismaLiveFactsDeps,
): Promise<LiveFactsResult> {
  // The work keeps running past the deadline; settle() means it can't reject.
  let pastDeadline = false;
  const work = settle(
    () => extractAndStore(userId, mail, opts, deps, () => pastDeadline),
    userId,
    mail.emailId,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<LiveFactsResult>((resolve) => {
    timer = setTimeout(() => {
      pastDeadline = true;
      resolve({ status: "timeout" });
    }, opts.deadlineMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
