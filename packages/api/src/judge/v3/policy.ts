/**
 * Policy v3: lanes from facts (docs/design/attention-engine-v3.md §3(4),
 * "Policy v3.0: exact evaluation").
 *
 * Pure and deterministic. It never reads a calibrated probability: the lane
 * follows from facts, relationship and the user's own pins/overrides. The
 * result is the PRE-budget lane. `pushCandidate` marks a PUSH the facts
 * produced; the interrupt budget (interrupt-budget.ts) is the separate step
 * that may hold it in QUEUE.
 *
 * First match wins:
 *   0. manual override, then pin
 *   1. MEETING  event, not bulk (before PUSH, as in v2: it notifies through
 *               its own lane and spends no interrupt budget)
 *   2. PUSH     addressed to me, no phishing suspicion, AND (a payment/security
 *               risk from a VIP sender OR an ask due within ±24h from a
 *               non-machine kind and a non-automated sender). Risk carries no
 *               evidence quote in facts v1, so on its own it needs a VIP
 *               sender: same domain or past replies are not enough, since
 *               spoofing and Klorn's own auto-replies could earn those.
 *   3. QUEUE    payment/security risk that did not PUSH, asks, personal/work_thread,
 *               my turn, transaction needing action
 *   4. INFO     transaction record, notification/receipt
 *   5. SILENT   bulk, newsletter/promotion
 *   6. QUEUE    default
 * Floors: ambiguous never SILENT/INFO; spam never PUSH/MEETING.
 * phishing_suspect never lands PUSH or MEETING and is surfaced as a reason.
 */

import type { LiveTier } from "@klorn/contract";
import { type Tier, toLiveTier } from "../tiers.js";
import type { FactsV1, MailKind, RelationshipSnapshot } from "./policy-types.js";
import { type PolicyReason, type ReasonParamValue, reason } from "./reasons.js";

/** Every policy version replay can run. Stored decisions name the one that decided. */
export const POLICY_VERSIONS = ["v3.0", "v3.1"] as const;
export type PolicyVersion = (typeof POLICY_VERSIONS)[number];
/** The version the live judge runs. */
export const POLICY_VERSION: PolicyVersion = "v3.1";

/**
 * What changed between versions (docs/design/attention-engine-v3.md §3(5)).
 * v3.1 (2026-11-07, measured on P1's 60 runs):
 *  - pushBeforeMeeting: a due-soon ask or a trusted risk interrupts even when
 *    the mail carries an event (cold-start urgent recall);
 *  - riskTrustsAuthenticated: a risk-only PUSH also trusts a From that passed
 *    DMARC, not only a VIP. A failed or missing verdict still needs a VIP;
 *  - notificationAsks: a notification may interrupt through a due-soon ask; an
 *    automated sender (no-reply, notifications@) still never does;
 *  - narrowSilent: SILENT is clear marketing only (the LOCKED rule): a
 *    promotion. Newsletters and other bulk mail are filed in INFO.
 */
interface PolicyRules {
  pushBeforeMeeting: boolean;
  riskTrustsAuthenticated: boolean;
  notificationAsks: boolean;
  narrowSilent: boolean;
}

const RULES: Readonly<Record<PolicyVersion, PolicyRules>> = {
  "v3.0": {
    pushBeforeMeeting: false,
    riskTrustsAuthenticated: false,
    notificationAsks: false,
    narrowSilent: false,
  },
  "v3.1": {
    pushBeforeMeeting: true,
    riskTrustsAuthenticated: true,
    notificationAsks: true,
    narrowSilent: true,
  },
};

/** The version stored when the v2 lane stood for missing LLM facts (live-decision.ts). */
export const V2_POLICY_VERSION = "v2";

/** An ask due within this window of the decision time is "due soon" (doc: ≤ 24h). */
export const DUE_SOON_MS = 24 * 60 * 60 * 1000;
/**
 * An overdue ask still counts as due soon for this long. Older deadlines are
 * stale, not an interrupt (they still rank at the top of QUEUE), and a
 * re-judge of old mail must not turn it into a PUSH.
 */
export const OVERDUE_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Machine-authored kinds interrupt only through `risk`, never through an ask.
 * From v3.1 a notification may, unless the sender is automated (pushMatch).
 */
const MACHINE_KINDS: ReadonlySet<MailKind> = new Set([
  "notification",
  "newsletter",
  "promotion",
  "receipt",
]);
const QUEUE_KINDS: ReadonlySet<MailKind> = new Set(["personal", "work_thread"]);
const INFO_KINDS: ReadonlySet<MailKind> = new Set(["notification", "receipt"]);
const SILENT_KINDS: ReadonlySet<MailKind> = new Set(["newsletter", "promotion"]);
const PUSH_RISKS = ["payment_failed", "security_alert"] as const;

export interface PolicyInput {
  facts: FactsV1;
  relationship: RelationshipSnapshot | null;
  pinnedTier?: Tier | null;
  manualOverrideTier?: Tier | null;
  /** Gmail put the message in spam (mailbox state, not a fact). */
  spam?: boolean;
  /**
   * Deterministic automated-sender signal (no-reply@, notifications@, …; the
   * extractor's pre-fact signals). An automated sender never interrupts
   * through an ask, whatever kind the model reported (v2 floor #794).
   */
  automatedSender?: boolean;
  /**
   * DMARC verdict for the From domain (pre-fact signal): false when it failed,
   * null when there is no verdict. A sender whose From failed authentication
   * is never trusted, so a forged VIP address earns nothing.
   */
  senderAuthenticated?: boolean | null;
  /** Decision time. Replay passes the mail's arrival time. Defaults to now. */
  decidedAt?: Date;
  /** Which version's rules decide. Defaults to POLICY_VERSION; replay may pick another. */
  version?: PolicyVersion;
}

export interface PolicyDecision {
  lane: LiveTier;
  reasons: PolicyReason[];
  policyVersion: PolicyVersion;
  pushCandidate: boolean;
}

interface Match {
  lane: LiveTier;
  reasons: PolicyReason[];
  pushCandidate: boolean;
}

export function laneFromFactsV3(input: PolicyInput): PolicyDecision {
  const version = input.version ?? POLICY_VERSION;
  const precedence = precedenceMatch(input);
  const matched = precedence ?? applyFloors(matchFacts(input, RULES[version]), input);
  const flagged = matched.reasons.some((r) => r.params.risk === "phishing_suspect");
  const supporting = [
    phishingSuspected(input.facts) && !flagged ? phishingReason() : null,
    relationshipReason(input.relationship),
  ].filter((r): r is PolicyReason => r !== null);
  return {
    lane: matched.lane,
    reasons: [...matched.reasons, ...supporting],
    policyVersion: version,
    pushCandidate: matched.pushCandidate,
  };
}

/**
 * A manual override is a human decision about this item, so it wins first; a
 * sender pin is a rule about the sender. That is the order in effect today:
 * an overridden item is preserved against any later judgement, a pin included.
 */
function precedenceMatch(input: PolicyInput): Match | null {
  if (input.manualOverrideTier) {
    const lane = toLiveTier(input.manualOverrideTier);
    return {
      lane,
      reasons: [reason("manual_override", { params: { tier: lane } })],
      pushCandidate: false,
    };
  }
  if (input.pinnedTier) {
    const lane = toLiveTier(input.pinnedTier);
    return { lane, reasons: [reason("pinned", { params: { tier: lane } })], pushCandidate: false };
  }
  return null;
}

function matchFacts(input: PolicyInput, rules: PolicyRules): Match {
  const f = input.facts;
  const decidedAt = input.decidedAt ?? new Date();
  const trusted = trustedSender(input.relationship, input.senderAuthenticated ?? null, rules);
  const push = pushMatch(f, trusted, decidedAt, input.automatedSender === true, rules);
  if (rules.pushBeforeMeeting && push) return push;
  if (f.event && f.addressedTo !== "bulk") {
    return only(
      "MEETING",
      reason("event", { fact: "event", params: { conflict: f.event.conflict } }),
    );
  }
  if (push) return push;
  return (
    queueMatch(f, trusted) ??
    infoMatch(f, rules) ??
    silentMatch(f, rules) ??
    only("QUEUE", reason("default_queue"))
  );
}

/**
 * Relationship trust for a risk with no evidence quote: VIP only (an
 * investor/customer label or a sender pinned to PUSH). Not "the user wrote to
 * them": sent-mail history also holds Klorn's unattended auto-replies, so an
 * attacker could earn it. SentMessage.origin (#1591) marks new Klorn sends, but
 * legacy rows stay null and read as the user's; widening is a later policyVersion.
 * A From that failed DMARC is never trusted: VIP labels match by address or
 * domain, which a forger can copy.
 */
function trustedSender(
  rel: RelationshipSnapshot | null,
  senderAuthenticated: boolean | null,
  rules: PolicyRules,
): boolean {
  if (rules.riskTrustsAuthenticated && senderAuthenticated === true) return true;
  return rel?.vip === true && senderAuthenticated !== false;
}

const pushRiskOf = (f: FactsV1) => PUSH_RISKS.find((r) => f.risk.includes(r));
const phishingReason = (): PolicyReason =>
  reason("risk", { fact: "risk", params: { risk: "phishing_suspect" } });
const phishingSuspected = (f: FactsV1) => f.risk.includes("phishing_suspect");

function pushMatch(
  f: FactsV1,
  trusted: boolean,
  decidedAt: Date,
  automatedSender: boolean,
  rules: PolicyRules,
): Match | null {
  if (f.addressedTo !== "me_direct" && f.addressedTo !== "me_cc") return null;
  if (phishingSuspected(f)) return null;
  const addressed = reason("addressed_to_me", {
    fact: "addressedTo",
    params: { addressedTo: f.addressedTo },
  });
  const risk = pushRiskOf(f);
  if (risk && trusted) {
    return {
      lane: "PUSH",
      reasons: [reason("risk", { fact: "risk", params: { risk, trusted: true } }), addressed],
      pushCandidate: true,
    };
  }
  const machine = rules.notificationAsks
    ? f.kind !== "notification" && MACHINE_KINDS.has(f.kind)
    : MACHINE_KINDS.has(f.kind);
  if (automatedSender || machine) return null;
  const soonest = earliestAskDueWithin(
    f,
    decidedAt.getTime() - OVERDUE_GRACE_MS,
    decidedAt.getTime() + DUE_SOON_MS,
  );
  if (soonest === null) return null;
  const ask = f.asks[soonest];
  const deciding = reason("ask_due_soon", {
    fact: `asks[${soonest}]`,
    evidence: ask.evidence,
    params: { askKind: ask.kind, due: ask.due },
  });
  return { lane: "PUSH", reasons: [deciding, addressed], pushCandidate: true };
}

/** Index of the ask with the earliest valid due date in [fromMs, toMs]. */
function earliestAskDueWithin(f: FactsV1, fromMs: number, toMs: number): number | null {
  let bestIndex: number | null = null;
  let bestAt = Number.POSITIVE_INFINITY;
  for (const [index, ask] of f.asks.entries()) {
    const at = ask.due ? Date.parse(ask.due) : Number.NaN;
    if (!Number.isFinite(at) || at < fromMs || at > toMs || at >= bestAt) continue;
    bestIndex = index;
    bestAt = at;
  }
  return bestIndex;
}

function queueMatch(f: FactsV1, trusted: boolean): Match | null {
  // A payment/security risk that did not interrupt is never filed or hidden,
  // even under a phishing suspicion (a false positive must stay visible).
  const risk = pushRiskOf(f);
  if (risk) {
    return only("QUEUE", reason("risk", { fact: "risk", params: { risk, trusted } }));
  }
  if (f.asks.length > 0) {
    const ask = f.asks[0];
    return only(
      "QUEUE",
      reason("ask", {
        fact: "asks[0]",
        evidence: ask.evidence,
        params: { askKind: ask.kind, due: ask.due },
      }),
    );
  }
  if (f.threadTurn === "mine_to_reply")
    return only("QUEUE", reason("thread_turn_mine", { fact: "threadTurn" }));
  if (f.transaction?.actionRequired) {
    return only(
      "QUEUE",
      reason("transaction_action", {
        fact: "transaction",
        params: { transactionKind: f.transaction.kind },
      }),
    );
  }
  if (QUEUE_KINDS.has(f.kind)) return only("QUEUE", kindReason(f.kind));
  return null;
}

function infoMatch(f: FactsV1, rules: PolicyRules): Match | null {
  if (rules.narrowSilent && f.kind === "newsletter") return only("INFO", kindReason(f.kind));
  if (rules.narrowSilent && f.addressedTo === "bulk" && f.kind !== "promotion") {
    return only("INFO", reason("bulk", { fact: "addressedTo" }));
  }
  if (f.transaction) {
    return only(
      "INFO",
      reason("transaction_record", {
        fact: "transaction",
        params: { transactionKind: f.transaction.kind },
      }),
    );
  }
  return INFO_KINDS.has(f.kind) ? only("INFO", kindReason(f.kind)) : null;
}

function silentMatch(f: FactsV1, rules: PolicyRules): Match | null {
  if (rules.narrowSilent) {
    return f.kind === "promotion" ? only("SILENT", kindReason(f.kind)) : null;
  }
  if (f.addressedTo === "bulk") return only("SILENT", reason("bulk", { fact: "addressedTo" }));
  return SILENT_KINDS.has(f.kind) ? only("SILENT", kindReason(f.kind)) : null;
}

function applyFloors(m: Match, input: PolicyInput): Match {
  if (input.facts.ambiguous && (m.lane === "SILENT" || m.lane === "INFO")) {
    return {
      lane: "QUEUE",
      reasons: [reason("ambiguous", { fact: "ambiguous" }), ...m.reasons],
      pushCandidate: false,
    };
  }
  if (phishingSuspected(input.facts) && m.lane === "MEETING") {
    return { lane: "QUEUE", reasons: [phishingReason(), ...m.reasons], pushCandidate: false };
  }
  if (input.spam && (m.lane === "PUSH" || m.lane === "MEETING")) {
    return { lane: "QUEUE", reasons: [reason("spam_floor"), ...m.reasons], pushCandidate: false };
  }
  return m;
}

const only = (lane: LiveTier, deciding: PolicyReason): Match => ({
  lane,
  reasons: [deciding],
  pushCandidate: false,
});

const kindReason = (kind: MailKind): PolicyReason =>
  reason("kind", { fact: "kind", params: { kind } });

/**
 * Relationship features a client may see: counts, dates and booleans only.
 * An allowlist, so a field added to the snapshot later never reaches clients
 * without a decision here.
 */
export const CLIENT_RELATIONSHIP_KEYS = [
  "sentCount",
  "lastSentAt",
  "medianReplyLatencyMs",
  "sameOrgDomain",
  "coAttendanceNext14d",
  "pinned",
  "vip",
  "dismissCount",
] as const satisfies ReadonlyArray<keyof RelationshipSnapshot>;

/** The WHO reason: only the relationship features that are known. */
function relationshipReason(rel: RelationshipSnapshot | null): PolicyReason | null {
  if (!rel) return null;
  const known = CLIENT_RELATIONSHIP_KEYS.filter((k) => rel[k] !== null).map(
    (k): [string, ReasonParamValue] => [k, rel[k]],
  );
  return known.length === 0 ? null : reason("relationship", { params: Object.fromEntries(known) });
}
