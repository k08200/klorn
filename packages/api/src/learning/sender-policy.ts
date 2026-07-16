/**
 * Sender-knowledge policy — SINGLE SOURCE OF TRUTH for what the firewall knows
 * about a sender and when that knowledge is strong enough to act on.
 *
 * This is the *entity* half of the deterministic core (tier-policy.ts is the
 * *relation* half). The LLM never decides who a sender is; this module defines:
 *   - the shape of observed sender knowledge (`SenderPrior`, `SenderFacts`,
 *     `CorrectionExample`) — the schema the rest of the engine reads,
 *   - `SENDER_PRIOR_POLICY`: the thresholds that turn raw history into a prior
 *     strong enough to skip the LLM (how many overrides, how fresh),
 *   - `PRIOR_SHORTCIRCUIT_TIERS`: which tiers a prior is even allowed to
 *     short-circuit to.
 *
 * Construction (judge-context.ts) and the short-circuit guard (poc-judge.ts)
 * both read these, so the sender ontology can't fork across the two files the
 * way it did before. These constants are the surface a future calibration pass
 * — tuned from accumulated overrides — will adjust; keep them data.
 */

import type { Tier } from "../judge/tiers.js";

/**
 * One past manual tier correction, rendered into the judge prompt as a
 * few-shot example. Mined from AttentionItem rows where isManualOverride is
 * true (see judge-context.ts) — tierReason's MANUAL_OVERRIDE_PREFIX text is
 * display-only, not the trust signal (GHSA-cxc5-fmqv-pxv6). The judge stays
 * pure — callers fetch these and pass them in.
 */
export interface CorrectionExample {
  from: string;
  subject: string;
  tier: Tier;
}

/**
 * A stable per-sender tier pattern strong enough to skip the LLM entirely.
 *  - "override": the user manually corrected this sender ≥OVERRIDE_PRIOR_MIN
 *    times to the same tier — the strongest possible signal.
 *  - "history": ≥HISTORY_PRIOR_MIN consecutive past classifications agreed.
 * Thresholds are enforced where the prior is constructed (judge-context.ts);
 * the short-circuit guard (poc-judge.ts) re-checks only the tier allowlist and
 * the urgency guard.
 */
export interface SenderPrior {
  tier: Tier;
  count: number;
  kind: "override" | "history";
}

/**
 * Deterministic, DB-derived facts about the sender, rendered into the judge
 * prompt as evidence for the senderTrust score. The LLM still scores — facts
 * ground it instead of letting it guess trust from surface cues alone
 * (engine review 2026-06-12: trust-score.ts was computed but never consumed
 * by classification). Assembled in judge-context.ts; the judge stays pure.
 */
export interface SenderFacts {
  /** Recent tier counts for this sender's mail, e.g. { QUEUE: 6, SILENT: 3 }. */
  tierHistory: Partial<Record<Tier, number>>;
  /** How many of those classifications were manual user corrections. */
  manualOverrides: number;
  /**
   * Interaction-graph node from the top-contacts cache. null means "not a
   * cached top contact", NOT "stranger" — never render absence as a fact.
   */
  interaction: {
    emailCount: number;
    lastEmailDaysAgo: number | null;
    upcomingMeetings: number;
  } | null;
  /** Commitment track record (only when the trust badge is load-bearing). */
  commitments: { onTime: number; total: number } | null;
  /**
   * Learned engagement: how much the user actually engages with this sender,
   * measured from real outbound replies/sends (importance 0..1 + raw count).
   * Flag-gated (CONTACT_ENGAGEMENT_IN_JUDGE); a soft senderTrust grounding fact,
   * never a hard tier decision. null when off or the sender has no engagement.
   *
   * `propagated` distinguishes the two kinds: false = directly measured
   * (outboundCount > 0, or a net-negative dismissed-only sender); true = an
   * inferred cold-start prior from the sender's organization (outboundCount 0,
   * much softer — rendered with weaker language).
   *
   * `dismissCount` is the negative half: how many times the user cleared this
   * sender's mail without engaging. A sender with outboundCount 0 and a
   * meaningful dismissCount is a measured "low importance" signal.
   */
  engagement: {
    importance: number;
    outboundCount: number;
    dismissCount?: number;
    propagated: boolean;
  } | null;
  /**
   * Measured read behavior: of the sender's recent mail (READ_BEHAVIOR
   * window), how much did the user actually open? The passive half of the
   * engagement channel — replies/dismisses need an action, but a sender the
   * user reads 100% vs 4% of is a real attention signal the outbound-only
   * counters are blind to (measured 2026-07-16: two buried-as-SILENT senders
   * at 100% read, one at 4%). Same flag (CONTACT_ENGAGEMENT_IN_JUDGE), same
   * doctrine: a soft senderTrust grounding, never a hard tier decision.
   * Optional so pre-existing fact literals stay valid; null/absent = no
   * signal (sample too small, flag off, or fetch failed).
   */
  readBehavior?: { read: number; total: number } | null;
}

/**
 * Read-behavior policy: the counting window, the minimum sample below which
 * the fact is suppressed (1 of 2 read tells nothing), and the rate bands that
 * pick the prompt wording (high = reads nearly everything, low = rarely opens).
 */
export const READ_BEHAVIOR = {
  windowDays: 90,
  minSample: 3,
  highRate: 0.8,
  lowRate: 0.2,
} as const;

/**
 * Which flavour of engagement grounding a decision used, for rollout
 * instrumentation (decision-label ledger). "DIRECT" = measured replies to this
 * sender; "PROPAGATED" = inferred from an engaged org peer; "DISMISSED" = the
 * user keeps clearing this sender without ever replying (measured negative);
 * null = none fired.
 */
export type EngagementKind = "DIRECT" | "PROPAGATED" | "DISMISSED";

/** Classify the engagement fact into its ledger kind. Pure. null when absent. */
export function engagementKindOf(facts: SenderFacts | null | undefined): EngagementKind | null {
  const e = facts?.engagement;
  if (!e) return null;
  if (e.propagated) return "PROPAGATED";
  if (e.outboundCount === 0 && (e.dismissCount ?? 0) > 0) return "DISMISSED";
  return "DIRECT";
}

/**
 * Thresholds that decide when raw sender history becomes an actionable prior
 * or a few-shot pool. Every magic number that used to sit inline in
 * judge-context.ts lives here, named, so the policy is one editable surface.
 */
export const SENDER_PRIOR_POLICY = {
  /** ≥ this many identical manual overrides → an "override" prior. */
  overrideMin: 2,
  /** ≥ this many unanimous recent classifications → a "history" prior. */
  historyMin: 3,
  /** Override priors older than this (days) are ignored — tastes drift. */
  overrideMaxAgeDays: 60,
  /** History priors older than this (days) are ignored. */
  historyMaxAgeDays: 30,
  /** How many of the sender's most recent emails to sample for a prior. */
  historySample: 10,
  /** How many past overrides to pull before ranking the few-shot pool. */
  correctionPoolSize: 50,
  /** Max correction few-shots rendered into the judge prompt. */
  maxFewShot: 5,
} as const;

/**
 * Which tiers a prior may short-circuit the LLM to, per prior kind.
 *
 * SILENT is deliberately excluded from both: a stale or wrong prior must not
 * be able to fully mute a sender with no LLM look — that is a silent one-way
 * door (the user never sees the suppressed mail, so they never override it to
 * correct the prior). A would-be-SILENT sender instead falls through to the
 * LLM on every email. AUTO is excluded because floors are the LLM's job, and
 * PUSH is override-only because urgency is content-dependent, not per-sender.
 */
export const PRIOR_SHORTCIRCUIT_TIERS: {
  readonly override: ReadonlySet<Tier>;
  readonly history: ReadonlySet<Tier>;
} = {
  override: new Set(["PUSH", "QUEUE"]),
  history: new Set(["QUEUE"]),
};
