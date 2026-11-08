/**
 * The v3 live decision inside the firewall judge (docs/design/attention-
 * engine-v3.md §3(5) "Live decision"), for users isJudgeV3PolicyEnabled
 * covers. email-firewall.ts calls planV3Write after the v2 judgement and
 * before it writes the item, so the lane and any budget hold are decided
 * before anyone can see the item. The fallback repair sweep calls it with
 * pushes off.
 *
 * Loaded lazily by email-firewall.ts, so a flag-off install never loads the
 * extractor's module graph.
 */

import type { LiveTier } from "@klorn/contract";
import { prisma } from "../../db.js";
import type { GmailRawEmail } from "../../mail/gmail-fetch.js";
import type { ProviderCredentials } from "../../providers/index.js";
import { captureError } from "../../sentry.js";
import type { JudgeableEmailRow } from "../email-firewall.js";
import { firewallBellRow, firewallPushGatesPass } from "../firewall-push.js";
import type { StaticTierReasonKey } from "../tier-reason-strings.js";
import { toLiveTier } from "../tiers.js";
import { findAttentionFacts } from "./facts-store.js";
import { judgeV3LivePolicyVersion } from "./flags.js";
import { importancePrior } from "./importance.js";
import {
  basisFromLive,
  basisFromStored,
  decideLiveLane,
  type FactsBasis,
  isTrustedSender,
  type LiveDecision,
  PRECEDENCE_SOURCES,
} from "./live-decision.js";
import { extractFactsForDecision } from "./live-facts.js";
import { type Hold, heldBudgetOf, type V3ItemFields, v3ItemFields } from "./live-item.js";
import { admitPushNotification, HELD_REASON_KEY } from "./push-budget-gate.js";
import { loadRelationshipSnapshot } from "./relationship-loader.js";
import { prismaShadowDeps, shadowMailFromRaw } from "./shadow.js";

/** How long the judge waits for live facts before the v2 lane stands. */
export const LIVE_FACTS_DEADLINE_MS = 20_000;

/** tierReason when the policy picked another lane than v2: v2's text would not explain it. */
export const V3_LANE_REASON_KEY: StaticTierReasonKey = "email.v3LaneFromFacts";

export type V3PushPlan =
  /** A PUSH whose bell row is written (slot claimed, or unbudgeted): ring after the write. */
  | { kind: "deliver"; notification: { id: string; createdAt: Date } }
  /** A MEETING: the usual unbudgeted firewall push after the write. */
  | { kind: "meeting" }
  | { kind: "none" };

export interface V3WritePlan {
  tier: LiveTier;
  reason: string;
  /**
   * v2's autoEligible survives only where v3 kept v2's lane and saw no
   * payment, security or phishing risk: unattended auto mode must never
   * answer mail the policy flagged.
   */
  autoEligible: boolean;
  v3: V3ItemFields;
  push: V3PushPlan;
}

export interface V3PlanInput {
  userId: string;
  email: JudgeableEmailRow;
  judgement: { tier: string; source: string | null; reason: string; autoEligible?: boolean };
  /** The item exists: a held item stays held. */
  rejudge: boolean;
  /** The freshly ingested message. Present: the live facts call. Absent: stored facts only. */
  liveRaw?: GmailRawEmail;
  credentials?: ProviderCredentials;
  /** False for backlog repair: no notification and no budget. */
  allowPush: boolean;
  now?: Date;
}

export async function planV3Write(input: V3PlanInput): Promise<V3WritePlan> {
  const v2Tier = toLiveTier(input.judgement.tier);
  const { basis, senderAuthenticated } = await resolveBasis(input, v2Tier);
  // After the facts wait (up to the deadline): the budget day, quiet hours and
  // heldAt follow the moment of the decision.
  const now = input.now ?? new Date();
  const decided = decideLiveLane({
    v2Tier,
    v2Source: input.judgement.source,
    email: input.email,
    receivedAt: input.email.receivedAt,
    basis,
    decidedAt: now,
    senderAuthenticated,
    policyVersion: judgeV3LivePolicyVersion(),
  });
  const decision = await withSenderTrust(input, decided, basis, senderAuthenticated, now);
  const plan = await planLane(
    input,
    decision,
    laneReason(decision, v2Tier, input.judgement.reason),
    now,
  );
  return { ...plan, autoEligible: keepsAutoEligible(input, decision, v2Tier) };
}

type LanePlan = Omit<V3WritePlan, "autoEligible">;

async function planLane(
  input: V3PlanInput,
  decision: LiveDecision,
  reason: string,
  now: Date,
): Promise<LanePlan> {
  if (decision.lane === "PUSH" && decision.budgeted) {
    const prior = input.rejudge ? await priorHold(input.userId, input.email.id) : null;
    if (prior) return heldPlan(decision, prior);
  }
  if (decision.lane === "PUSH") return planPush(input, decision, reason, now);
  const push: V3PushPlan =
    decision.lane === "MEETING" && input.allowPush ? { kind: "meeting" } : { kind: "none" };
  return { tier: decision.lane, reason, v3: v3ItemFields(decision, null), push };
}

function keepsAutoEligible(input: V3PlanInput, decision: LiveDecision, v2Tier: LiveTier): boolean {
  // decision.lane, not the written tier: a hold must not mask a lane change.
  if (input.judgement.autoEligible !== true || decision.lane !== v2Tier) return false;
  return !decision.reasons.some((r) => r.code === "risk");
}

/** The judgement to write under a v3 plan: v2's, with the plan's lane, reason and autoEligible. */
export function judgementUnderPlan<
  J extends { tier: string; reason: string; autoEligible?: boolean },
>(judgement: J, plan: V3WritePlan): J {
  return { ...judgement, tier: plan.tier, reason: plan.reason, autoEligible: plan.autoEligible };
}

function laneReason(decision: LiveDecision, v2Tier: LiveTier, v2Reason: string): string {
  const policyChangedLane =
    decision.basis !== "v2" && !decision.precedence && decision.lane !== v2Tier;
  return policyChangedLane ? V3_LANE_REASON_KEY : v2Reason;
}

function heldPlan(decision: LiveDecision, hold: Hold): LanePlan {
  return {
    tier: "QUEUE",
    reason: HELD_REASON_KEY,
    v3: v3ItemFields(decision, hold),
    push: { kind: "none" },
  };
}

/**
 * A PUSH: the existing gates first (they spend nothing), then a budget slot
 * claimed with the bell row. No slot left: the item is written as QUEUE,
 * held, and nothing rings.
 */
async function planPush(
  input: V3PlanInput,
  decision: LiveDecision,
  reason: string,
  now: Date,
): Promise<LanePlan> {
  const quiet: LanePlan = {
    tier: "PUSH",
    reason,
    v3: v3ItemFields(decision, null),
    push: { kind: "none" },
  };
  if (!input.allowPush) return (await keptFallbackMeeting(input, decision)) ?? quiet;
  if (!(await firewallPushGatesPass(input.userId, input.email, true))) {
    return (await keptFallbackMeeting(input, decision)) ?? quiet;
  }
  const admission = await admitPushNotification(input.userId, firewallBellRow(input.email), {
    pinned: !decision.budgeted,
    trusted: decision.trusted,
    now,
  });
  if (admission.status !== "held") {
    return { ...quiet, push: { kind: "deliver", notification: admission.notification } };
  }
  // An urgent invite (v3.1 checks PUSH before MEETING) notifies as the MEETING
  // v3.0 would have shown, outside the budget, rather than being held silent.
  if (decision.meetingFallback) {
    return fallbackMeetingPlan(input, decision, decision.meetingFallback, { kind: "meeting" });
  }
  // Ids only: an IMAP gmailId embeds the mailbox address.
  console.log(
    `[PUSH-BUDGET] Firewall PUSH held in QUEUE: daily interrupt budget ${admission.limit} ` +
      `spent, for email ${input.email.id} user ${input.userId}`,
  );
  return heldPlan(decision, { heldAt: now, budget: admission.limit });
}

function fallbackMeetingPlan(
  input: V3PlanInput,
  decision: LiveDecision,
  reasons: LiveDecision["reasons"],
  push: V3PushPlan,
): LanePlan {
  const meeting = { ...decision, lane: "MEETING" as const, reasons };
  return {
    tier: "MEETING",
    reason: laneReason(meeting, toLiveTier(input.judgement.tier), input.judgement.reason),
    v3: v3ItemFields(meeting, null),
    push,
  };
}

/**
 * An invite already shown as MEETING stays MEETING when this pass cannot ring
 * its PUSH (a re-judge, or a push gate such as the dedupe). Like a hold, the
 * fallback is final: a PUSH written here would hold no budget slot.
 */
async function keptFallbackMeeting(
  input: V3PlanInput,
  decision: LiveDecision,
): Promise<LanePlan | null> {
  if (!decision.meetingFallback || !decision.budgeted) return null;
  const item = await prisma.attentionItem.findUnique({
    where: {
      userId_source_sourceId: { userId: input.userId, source: "EMAIL", sourceId: input.email.id },
    },
    select: { tier: true },
  });
  if (item?.tier !== "MEETING") return null;
  return fallbackMeetingPlan(input, decision, decision.meetingFallback, { kind: "none" });
}

/**
 * A budgeted PUSH needs to know whether the sender is trusted (the slot
 * reserve). When the decision had no relationship (no facts, or a precedence
 * source decided), load it: database only, no model call. A failed load
 * leaves the sender a stranger, the safe side.
 */
async function withSenderTrust(
  input: V3PlanInput,
  decision: LiveDecision,
  basis: FactsBasis,
  senderAuthenticated: boolean | null | undefined,
  now: Date,
): Promise<LiveDecision> {
  const needsTrust = decision.lane === "PUSH" && decision.budgeted && input.allowPush;
  if (!needsTrust || basis.relationship !== null) return decision;
  try {
    const { userAddresses } = await prismaShadowDeps.userContext(input.userId);
    const relationship = await loadRelationshipSnapshot({
      userId: input.userId,
      senderAddress: input.email.from,
      userAddresses,
      senderAuthenticated: senderAuthenticated ?? null,
      excludeEmailId: input.email.id,
    });
    return {
      ...decision,
      trusted: isTrustedSender(relationship, senderAuthenticated ?? null),
      importance: importancePrior(relationship, now),
    };
  } catch (err) {
    captureError(err, {
      tags: { scope: "judge-v3-sender-trust" },
      extra: { userId: input.userId, emailId: input.email.id },
    });
    return decision;
  }
}

/** A hold already on the item: final, so a re-judge keeps it (doc step 6). */
async function priorHold(userId: string, emailId: string): Promise<Hold | null> {
  const item = await prisma.attentionItem.findUnique({
    where: { userId_source_sourceId: { userId, source: "EMAIL", sourceId: emailId } },
    select: { heldAt: true, v3Decision: true },
  });
  if (!item?.heldAt) return null;
  return { heldAt: item.heldAt, budget: heldBudgetOf(item.v3Decision) };
}

interface ResolvedBasis {
  basis: FactsBasis;
  /** DMARC verdict when known; undefined lets the decision read the LLM basis signals. */
  senderAuthenticated: boolean | null | undefined;
}

async function resolveBasis(input: V3PlanInput, v2Tier: LiveTier): Promise<ResolvedBasis> {
  const noFacts: FactsBasis = { kind: "none", pre: null, relationship: null };
  if (input.liveRaw) {
    const mail = shadowMailFromRaw(input.email.id, input.liveRaw);
    // A precedence source decides without facts: no model call for it.
    if (isPrecedence(input))
      return { basis: noFacts, senderAuthenticated: mail.senderAuthenticated };
    const result = await extractFactsForDecision(input.userId, mail, {
      v2Tier,
      credentials: input.credentials,
      deadlineMs: LIVE_FACTS_DEADLINE_MS,
    });
    return { basis: basisFromLive(result), senderAuthenticated: mail.senderAuthenticated };
  }
  if (isPrecedence(input)) return { basis: noFacts, senderAuthenticated: undefined };
  const stored = await findAttentionFacts(input.userId, "EMAIL", input.email.id);
  const auth = stored?.signals?.senderAuthenticated;
  return {
    basis: basisFromStored(stored),
    senderAuthenticated: typeof auth === "boolean" ? auth : undefined,
  };
}

const isPrecedence = (input: V3PlanInput): boolean =>
  Boolean(input.judgement.source && PRECEDENCE_SOURCES[input.judgement.source]);
