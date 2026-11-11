/**
 * Policy v3: lanes from facts (docs/design/attention-engine-v3.md §3(5)). The
 * rules below are v3.0; RULES lists what v3.1, the live version, changes.
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
 * Floors: ambiguous never SILENT/INFO; spam never PUSH/MEETING;
 * phishing_suspect never PUSH/MEETING (and is surfaced as a reason).
 * v3.2 adds a floor: from a first-contact sender, a PUSH or MEETING that
 * carries a pay ask or an event goes to QUEUE (firstContactGate).
 */

import type { LiveTier } from "@klorn/contract";
import { type Tier, toLiveTier } from "../tiers.js";
import type { FactsV1, MailKind, RelationshipSnapshot } from "./policy-types.js";
import { type PolicyReason, type ReasonParamValue, reason } from "./reasons.js";

/** Every policy version replay can run. Stored decisions name the one that decided. */
export const POLICY_VERSIONS = ["v3.0", "v3.1", "v3.2"] as const;
export type PolicyVersion = (typeof POLICY_VERSIONS)[number];
/** The version the live judge runs. v3.2 is opt-in (JUDGE_V3_POLICY_VERSION). */
export const POLICY_VERSION: PolicyVersion = "v3.1";

/**
 * What changed between versions (docs/design/attention-engine-v3.md §3(5)).
 * v3.1 (2026-11-07, measured on P1's 60 runs):
 *  - pushBeforeMeeting: a due-soon ask or a trusted risk interrupts even when
 *    the mail carries an event (cold-start urgent recall);
 *  - riskTrustsAuthenticated: a risk-only PUSH also trusts a known
 *    correspondent whose From passed DMARC: one that has mailed the user at
 *    least RISK_TRUST_MIN_INBOUND times, the first at least
 *    RISK_TRUST_MIN_HISTORY_MS before. DMARC alone is not enough: a fresh
 *    webmail account or an attacker's own domain passes it. Never for an
 *    ambiguous fact set or a promotion/newsletter. A failed or missing
 *    verdict still needs a VIP;
 *  - notificationAsks: a notification may interrupt through a due-soon ask,
 *    unless the sender is automated (no-reply, notifications@) or its From
 *    failed DMARC;
 *  - narrowSilent: SILENT is clear marketing only (the LOCKED rule): a
 *    promotion. Newsletters and other bulk mail are filed in INFO.
 * v3.2 (2026-11-10, opt-in; measured on P1's 60 runs and the phishing set):
 *  - firstContactGate: from a sender with no established contact
 *    (isFirstContact), mail that carries a pay ask or an event does not
 *    interrupt: what would be PUSH or MEETING goes to QUEUE (#1649's two
 *    phishing misses);
 *  - dueWindow: the due-soon window is a per-version parameter. v3.2 keeps
 *    ±24h: wider fixed windows changed nothing on the eval sets (doc §3(5)).
 */
export interface PolicyRules {
  readonly pushBeforeMeeting: boolean;
  readonly riskTrustsAuthenticated: boolean;
  readonly notificationAsks: boolean;
  readonly narrowSilent: boolean;
  readonly firstContactGate: FirstContactGate;
  readonly dueWindow: DueWindow;
}

/** What the first-contact gate holds in QUEUE: mail with a pay ask, mail with an event. */
export interface FirstContactGate {
  readonly payAsk: boolean;
  readonly event: boolean;
}
const NO_GATE: FirstContactGate = { payAsk: false, event: false };

/**
 * An ask is due soon when its due falls in [decidedAt − overdueMs,
 * decidedAt + aheadMs]. The overdue side keeps a re-judge of old mail from
 * turning a stale deadline into a PUSH.
 */
export interface DueWindow {
  readonly overdueMs: number;
  readonly aheadMs: number;
}

/** riskTrustsAuthenticated: how much history makes an authenticated sender known. */
export const RISK_TRUST_MIN_INBOUND = 3;
export const RISK_TRUST_MIN_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;

/** An ask due within this window of the decision time is "due soon" (doc: ≤ 24h). */
export const DUE_SOON_MS = 24 * 60 * 60 * 1000;
/**
 * An overdue ask still counts as due soon for this long. Older deadlines are
 * stale, not an interrupt (they still rank at the top of QUEUE), and a
 * re-judge of old mail must not turn it into a PUSH.
 */
export const OVERDUE_GRACE_MS = 24 * 60 * 60 * 1000;
const DUE_WINDOW_24H: DueWindow = { overdueMs: OVERDUE_GRACE_MS, aheadMs: DUE_SOON_MS };

const RULES: Readonly<Record<PolicyVersion, PolicyRules>> = {
  "v3.0": {
    pushBeforeMeeting: false,
    riskTrustsAuthenticated: false,
    notificationAsks: false,
    narrowSilent: false,
    firstContactGate: NO_GATE,
    dueWindow: DUE_WINDOW_24H,
  },
  "v3.1": {
    pushBeforeMeeting: true,
    riskTrustsAuthenticated: true,
    notificationAsks: true,
    narrowSilent: true,
    firstContactGate: NO_GATE,
    dueWindow: DUE_WINDOW_24H,
  },
  "v3.2": {
    pushBeforeMeeting: true,
    riskTrustsAuthenticated: true,
    notificationAsks: true,
    narrowSilent: true,
    firstContactGate: { payAsk: true, event: true },
    dueWindow: DUE_WINDOW_24H,
  },
};

/** A version's rules, e.g. as the base of a candidate in the variants eval. */
export function policyRules(version: PolicyVersion): PolicyRules {
  return RULES[version];
}

/** The version stored when the v2 lane stood for missing LLM facts (live-decision.ts). */
export const V2_POLICY_VERSION = "v2";

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
  // An unknown version (never from a typed caller) runs the live rules.
  const version: PolicyVersion =
    input.version && Object.hasOwn(RULES, input.version) ? input.version : POLICY_VERSION;
  return { ...decideUnder(input, RULES[version]), policyVersion: version };
}

/**
 * Eval only (scripts/v3-policy-variants.ts): the lane under a candidate rule
 * set that is not a version yet, so a variant is measured before it ships.
 * The live judge and replay go through laneFromFactsV3. `input.version` is ignored.
 */
export function laneFromFactsUnderRules(
  input: PolicyInput,
  rules: PolicyRules,
): Omit<PolicyDecision, "policyVersion"> {
  return decideUnder(input, rules);
}

function decideUnder(
  input: PolicyInput,
  rules: PolicyRules,
): Omit<PolicyDecision, "policyVersion"> {
  const precedence = precedenceMatch(input);
  const matched = precedence ?? applyFloors(matchFacts(input, rules), input, rules);
  const flagged = matched.reasons.some((r) => r.params.risk === "phishing_suspect");
  const supporting = [
    phishingSuspected(input.facts) && !flagged ? phishingReason() : null,
    relationshipReason(input.relationship),
  ].filter((r): r is PolicyReason => r !== null);
  return {
    lane: matched.lane,
    reasons: [...matched.reasons, ...supporting],
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
  const auth = input.senderAuthenticated ?? null;
  const trusted = trustedSender(f, input.relationship, auth, decidedAt, rules);
  const push = pushMatch(f, { trusted, auth }, decidedAt, input.automatedSender === true, rules);
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
 * Relationship trust for a risk with no evidence quote. v3.0: VIP only (an
 * investor/customer label or a sender pinned to PUSH). Not "the user wrote to
 * them": sent-mail history also holds Klorn's unattended auto-replies, so an
 * attacker could earn it. A From that failed DMARC is never trusted: VIP labels
 * match by address or domain, which a forger can copy.
 *
 * v3.1 (riskTrustsAuthenticated) adds a known correspondent whose From passed
 * DMARC: DMARC proves the domain sent the mail, the inbound history that the
 * sender is one the user has heard from for a while. Neither alone is enough.
 */
function trustedSender(
  f: FactsV1,
  rel: RelationshipSnapshot | null,
  auth: boolean | null,
  decidedAt: Date,
  rules: PolicyRules,
): boolean {
  if (auth === false) return false;
  if (rel?.vip === true) return true;
  if (!rules.riskTrustsAuthenticated || auth !== true) return false;
  if (f.ambiguous || f.kind === "promotion" || f.kind === "newsletter") return false;
  return knownCorrespondent(rel, decidedAt);
}

function knownCorrespondent(rel: RelationshipSnapshot | null, decidedAt: Date): boolean {
  if ((rel?.inboundCount ?? 0) < RISK_TRUST_MIN_INBOUND || !rel?.firstSeenAt) return false;
  const firstSeen = Date.parse(rel.firstSeenAt);
  return Number.isFinite(firstSeen) && decidedAt.getTime() - firstSeen >= RISK_TRUST_MIN_HISTORY_MS;
}

/**
 * Sends to a sender before they count as someone the user writes to. One reply
 * (a "who is this?") is not a relationship. The slot reserve uses the same bar
 * (live-decision.ts).
 */
export const TRUSTED_MIN_SENT = 2;

/**
 * v3.2 first contact: no established contact with the sender. Established
 * contact is any of these RelationshipSnapshot fields (relationship.ts, loaded
 * by relationship-loader.ts), each a bar this file or live-decision.ts already
 * trusts:
 *  - vip: an investor/customer label, or a sender pinned to PUSH;
 *  - sentCount ≥ TRUSTED_MIN_SENT: the user wrote to them twice (Klorn's
 *    unattended sends do not count, RELATIONSHIP_EVIDENCE_ORIGINS);
 *  - a known correspondent: RISK_TRUST_MIN_INBOUND earlier mails, the first at
 *    least RISK_TRUST_MIN_HISTORY_MS ago (the loader leaves out the mail being
 *    judged). One earlier mail is not enough: the same phish sent twice is;
 *  - meetingCount ≥ 1: a past meeting the user accepted or organised.
 * Not sameOrgDomain: an attacker with a free account at the user's mail
 * provider shares the domain whenever that provider is missing from the
 * public-domain list. A null field is not evidence (fails closed). Neither is
 * history behind a From that failed DMARC: it matches by address, which a
 * forger copies. A null verdict (no Authentication-Results, as on Outlook and
 * IMAP) leaves that copy open.
 */
export function isFirstContact(
  rel: RelationshipSnapshot,
  auth: boolean | null,
  decidedAt: Date,
): boolean {
  if (auth === false) return true;
  const contact =
    rel.vip === true ||
    (rel.sentCount ?? 0) >= TRUSTED_MIN_SENT ||
    knownCorrespondent(rel, decidedAt) ||
    (rel.meetingCount ?? 0) > 0;
  return !contact;
}

/**
 * The first-contact floor: a pay ask or an event is how a stranger's mail
 * (an invoice to settle today, an invite with a join link) reaches PUSH or
 * MEETING with no sign of spoofing. QUEUE keeps it visible and ranked; the
 * interrupt it would have made follows as supporting reasons. Mail with
 * neither keeps its lane: a stranger's due-soon reply ask still interrupts.
 */
function firstContactHold(f: FactsV1, interrupt: Match, gate: FirstContactGate): Match | null {
  const payAsk = f.asks.some((a) => a.kind === "pay");
  const event = f.event !== null;
  const held = { payAsk: gate.payAsk && payAsk, event: gate.event && event };
  if (!held.payAsk && !held.event) return null;
  return {
    lane: "QUEUE",
    reasons: [reason("first_contact", { params: held }), ...interrupt.reasons],
    pushCandidate: false,
  };
}

const pushRiskOf = (f: FactsV1) => PUSH_RISKS.find((r) => f.risk.includes(r));
const phishingReason = (): PolicyReason =>
  reason("risk", { fact: "risk", params: { risk: "phishing_suspect" } });
const phishingSuspected = (f: FactsV1) => f.risk.includes("phishing_suspect");

function pushMatch(
  f: FactsV1,
  sender: { trusted: boolean; auth: boolean | null },
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
  if (risk && sender.trusted) {
    return {
      lane: "PUSH",
      reasons: [reason("risk", { fact: "risk", params: { risk, trusted: true } }), addressed],
      pushCandidate: true,
    };
  }
  // v3.1: a notification may interrupt through an ask, but not one whose From
  // failed DMARC (a forged brand notification).
  const notificationMay =
    rules.notificationAsks && f.kind === "notification" && sender.auth !== false;
  const machine = MACHINE_KINDS.has(f.kind) && !notificationMay;
  if (automatedSender || machine) return null;
  const soonest = earliestAskDueWithin(
    f,
    decidedAt.getTime() - rules.dueWindow.overdueMs,
    decidedAt.getTime() + rules.dueWindow.aheadMs,
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
  // `trusted` says whether the sender was trusted for a risk-only interrupt;
  // never under a phishing suspicion.
  const risk = pushRiskOf(f);
  if (risk) {
    const shown = trusted && !phishingSuspected(f);
    return only("QUEUE", reason("risk", { fact: "risk", params: { risk, trusted: shown } }));
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
  if (f.transaction) {
    return only(
      "INFO",
      reason("transaction_record", {
        fact: "transaction",
        params: { transactionKind: f.transaction.kind },
      }),
    );
  }
  if (INFO_KINDS.has(f.kind)) return only("INFO", kindReason(f.kind));
  // v3.1 narrow SILENT: newsletters and other bulk mail are filed here.
  if (rules.narrowSilent && f.kind === "newsletter") return only("INFO", kindReason(f.kind));
  if (rules.narrowSilent && f.addressedTo === "bulk" && f.kind !== "promotion") {
    return only("INFO", reason("bulk", { fact: "addressedTo" }));
  }
  return null;
}

function silentMatch(f: FactsV1, rules: PolicyRules): Match | null {
  if (rules.narrowSilent) {
    return f.kind === "promotion" ? only("SILENT", kindReason(f.kind)) : null;
  }
  if (f.addressedTo === "bulk") return only("SILENT", reason("bulk", { fact: "addressedTo" }));
  return SILENT_KINDS.has(f.kind) ? only("SILENT", kindReason(f.kind)) : null;
}

function applyFloors(m: Match, input: PolicyInput, rules: PolicyRules): Match {
  if (input.facts.ambiguous && (m.lane === "SILENT" || m.lane === "INFO")) {
    return {
      lane: "QUEUE",
      reasons: [reason("ambiguous", { fact: "ambiguous" }), ...m.reasons],
      pushCandidate: false,
    };
  }
  // pushMatch already vetoes it; the floor keeps the invariant independent of rule order.
  if (phishingSuspected(input.facts) && (m.lane === "PUSH" || m.lane === "MEETING")) {
    return { lane: "QUEUE", reasons: [phishingReason(), ...m.reasons], pushCandidate: false };
  }
  if (input.spam && (m.lane === "PUSH" || m.lane === "MEETING")) {
    return { lane: "QUEUE", reasons: [reason("spam_floor"), ...m.reasons], pushCandidate: false };
  }
  // v3.2. After the phishing and spam floors, so their reason decides when both
  // apply. No snapshot at all means the decision has no relationship basis: the
  // keyword fallback while the model is down, where v2 parity holds (doc
  // principle 9). Live LLM facts always come with one (live-facts.ts).
  if ((m.lane === "PUSH" || m.lane === "MEETING") && input.relationship) {
    const auth = input.senderAuthenticated ?? null;
    const hold = firstContactHold(input.facts, m, rules.firstContactGate);
    if (hold && isFirstContact(input.relationship, auth, input.decidedAt ?? new Date())) {
      return hold;
    }
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
