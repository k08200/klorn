/**
 * The v3 lane decision for one item (docs/design/attention-engine-v3.md §3(5)
 * "Live decision"). The firewall judge and replay both call it, so replay
 * shows what the live path would do. Pure.
 *
 * Order:
 *  1. A manual override (replay only: live, the upsert preserves it) or a pin
 *     keeps its lane. The other v2 precedence sources (marketing fast-path,
 *     sender prior, learned rule) keep the v2 lane with their reason.
 *  2. LLM facts → the policy (the live version, or the one replay names).
 *  3. No LLM facts → the v2 lane, unless the v2 judge itself fell back to
 *     keywords: then keyword facts merged with the certain pre-facts.
 */

import type { LiveTier } from "@klorn/contract";
import type { ClassifiableEmail } from "../email-classifier.js";
import { isAutomatedSender } from "../keyword-policy.js";
import { hasSpamLabel } from "../poc-judge.js";
import { type CertainPreFacts, mergeWithPreFacts } from "./facts-merge.js";
import type { StoredFacts } from "./facts-store.js";
import { importancePrior } from "./importance.js";
import { keywordFactsV1 } from "./keyword-facts.js";
import type { LiveFactsResult } from "./live-facts.js";
import {
  laneFromFactsV3,
  POLICY_VERSION,
  type PolicyVersion,
  V2_POLICY_VERSION,
} from "./policy.js";
import type { FactsV1, RelationshipSnapshot, ThreadTurn } from "./policy-types.js";
import type { PreFactSignals } from "./pre-facts.js";
import { rankDue } from "./ranking.js";
import { type PolicyReason, type ReasonCode, reason } from "./reasons.js";

/** What the decision can stand on for this item. */
export type FactsBasis =
  /** The extractor's LLM facts (live, or the stored row). */
  | {
      kind: "llm";
      facts: FactsV1;
      relationship: RelationshipSnapshot | null;
      signals: PreFactSignals | null;
    }
  /** No LLM facts: the extractor failed, timed out or was refused, or no row exists. */
  | { kind: "none"; pre: CertainPreFacts | null; relationship: RelationshipSnapshot | null }
  /** Replay's model-down estimate: keyword facts for every item. */
  | { kind: "keyword"; pre: CertainPreFacts | null; relationship: RelationshipSnapshot | null };

export interface LiveDecisionInput {
  /** The lane the v2 judge decided. */
  v2Tier: LiveTier;
  /** The v2 judge source (PocJudgement.source / DecisionLabel.decidedBy). */
  v2Source: string | null;
  /** Replay only. Live, a manual override is preserved by the upsert. */
  manualOverride?: boolean;
  email: ClassifiableEmail;
  receivedAt: Date;
  basis: FactsBasis;
  decidedAt: Date;
  /**
   * DMARC verdict for the From domain, when the caller has the message (live
   * ingest). Otherwise the stored signal is used. false = failed.
   */
  senderAuthenticated?: boolean | null;
  /** Which policy version decides (replay); defaults to the live one. */
  policyVersion?: PolicyVersion;
}

export { V2_POLICY_VERSION } from "./policy.js";

export interface LiveDecision {
  /** The lane before the interrupt budget. */
  lane: LiveTier;
  /** The policy version that decided ("v3.0", "v3.1"); "v2" when the v2 lane stood for missing facts. */
  policyVersion: PolicyVersion | typeof V2_POLICY_VERSION;
  /** reasons[0] decides the lane; empty for "v2". */
  reasons: PolicyReason[];
  pushCandidate: boolean;
  /** A PUSH spends interrupt budget: false only for a pin or a manual override. */
  budgeted: boolean;
  /** A precedence source decided the lane. */
  precedence: boolean;
  basis: "llm" | "keyword" | "v2";
  /** Ranking due (ISO), or null. */
  due: string | null;
  threadTurn: ThreadTurn | null;
  importance: number;
  /** Trusted for the slot reserve: a VIP, or someone the user wrote to. */
  trusted: boolean;
  /**
   * The MEETING reasons, when this PUSH carries an event that v3.0 would have
   * shown as MEETING (v3.1 checks PUSH first). If the interrupt budget holds
   * the PUSH, the mail notifies as that MEETING instead, outside the budget,
   * exactly as v3.0 did: an urgent invite is never worse off than before.
   */
  meetingFallback: PolicyReason[] | null;
}

/** v2 sources that short-circuit before facts, with their reason code. */
export const PRECEDENCE_SOURCES: Readonly<Record<string, ReasonCode>> = {
  "pinned-rule": "pinned",
  "fast-path": "kind",
  "sender-prior": "sender_pattern",
  "learned-rule": "learned_rule",
};

const KEYWORD_FALLBACK_SOURCE = "keyword-fallback";

/**
 * Sends to a sender before they count as someone the user writes to. One reply
 * (a "who is this?") is not a relationship.
 */
export const TRUSTED_MIN_SENT = 2;

/**
 * Trusted for the slot reserve: a VIP, or someone the user has written to at
 * least twice. Never a sender whose From failed DMARC: VIP labels and sent
 * history match by address, which a forger can copy.
 */
export function isTrustedSender(
  rel: RelationshipSnapshot | null,
  senderAuthenticated: boolean | null,
): boolean {
  if (senderAuthenticated === false) return false;
  return rel?.vip === true || (rel?.sentCount ?? 0) >= TRUSTED_MIN_SENT;
}

/** A stored boolean signal, or null when absent or malformed. */
const flag = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

export function decideLiveLane(input: LiveDecisionInput): LiveDecision {
  const relationship = input.basis.relationship;
  const signals = input.basis.kind === "llm" ? input.basis.signals : null;
  const senderAuthenticated =
    input.senderAuthenticated !== undefined
      ? input.senderAuthenticated
      : flag(signals?.senderAuthenticated);
  const common = {
    importance: importancePrior(relationship, input.decidedAt),
    trusted: isTrustedSender(relationship, senderAuthenticated),
  };
  const precedence = precedenceDecision(input);
  if (precedence) return { ...precedence, ...common };

  const facts = factsFor(input);
  if (facts === null) {
    return {
      lane: input.v2Tier,
      policyVersion: V2_POLICY_VERSION,
      reasons: [],
      pushCandidate: false,
      budgeted: true,
      precedence: false,
      basis: "v2",
      due: null,
      threadTurn: null,
      meetingFallback: null,
      ...common,
    };
  }
  const decision = laneFromFactsV3({
    facts,
    relationship,
    spam: flag(signals?.spam) ?? hasSpamLabel(input.email.labels),
    automatedSender: flag(signals?.automatedSender) ?? isAutomatedSender(input.email.from || ""),
    senderAuthenticated,
    decidedAt: input.decidedAt,
    version: input.policyVersion,
  });
  return {
    lane: decision.lane,
    policyVersion: decision.policyVersion,
    reasons: decision.reasons,
    pushCandidate: decision.pushCandidate,
    budgeted: true,
    precedence: false,
    basis: input.basis.kind === "llm" ? "llm" : "keyword",
    due: rankDue(facts, input.decidedAt),
    threadTurn: facts.threadTurn,
    meetingFallback: decision.lane === "PUSH" ? meetingFallbackOf(facts, decision.reasons) : null,
    ...common,
  };
}

/**
 * The MEETING a v3.0 ordering would have given this mail (an event, not bulk,
 * no phishing), with the same supporting relationship reason.
 */
function meetingFallbackOf(
  facts: FactsV1,
  reasons: readonly PolicyReason[],
): PolicyReason[] | null {
  if (!facts.event || facts.addressedTo === "bulk") return null;
  if (facts.risk.includes("phishing_suspect")) return null;
  return [
    reason("event", { fact: "event", params: { conflict: facts.event.conflict } }),
    ...reasons.filter((r) => r.code === "relationship"),
  ];
}

type PrecedenceDecision = Omit<LiveDecision, "importance" | "trusted">;

function precedenceDecision(input: LiveDecisionInput): PrecedenceDecision | null {
  const unbudgeted = input.manualOverride === true || input.v2Source === "pinned-rule";
  const code: ReasonCode | undefined = input.manualOverride
    ? "manual_override"
    : input.v2Source
      ? PRECEDENCE_SOURCES[input.v2Source]
      : undefined;
  if (!code) return null;
  return {
    lane: input.v2Tier,
    policyVersion: input.policyVersion ?? POLICY_VERSION,
    reasons: [reason(code, { params: { tier: input.v2Tier } })],
    pushCandidate: false,
    budgeted: !unbudgeted,
    precedence: true,
    // The v2 judge's own precedence decided, not facts.
    basis: "v2",
    due: null,
    threadTurn: null,
    meetingFallback: null,
  };
}

/** The facts the policy runs on, or null when the v2 lane stands. */
function factsFor(input: LiveDecisionInput): FactsV1 | null {
  const { basis } = input;
  if (basis.kind === "llm") return basis.facts;
  if (basis.kind === "none" && input.v2Source !== KEYWORD_FALLBACK_SOURCE) return null;
  const keyword = keywordFactsV1(input.email, input.receivedAt);
  return basis.pre ? mergeWithPreFacts(keyword, basis.pre) : keyword;
}

/** The basis from the live facts call: only "ok" with LLM facts reaches the policy. */
export function basisFromLive(result: LiveFactsResult): FactsBasis {
  if (result.status !== "ok") return { kind: "none", pre: null, relationship: null };
  const { extraction, relationship } = result;
  if (extraction.source === "llm" && extraction.facts) {
    return { kind: "llm", facts: extraction.facts, relationship, signals: extraction.signals };
  }
  return {
    kind: "none",
    pre: { facts: extraction.preFacts, certain: extraction.certain },
    relationship,
  };
}

export function basisFromStored(stored: StoredFacts | null): FactsBasis {
  if (!stored) return { kind: "none", pre: null, relationship: null };
  if (stored.factsSource === "llm" && stored.facts) {
    return {
      kind: "llm",
      facts: stored.facts,
      relationship: stored.relationship,
      signals: stored.signals,
    };
  }
  return { kind: "none", pre: stored.pre, relationship: stored.relationship };
}
