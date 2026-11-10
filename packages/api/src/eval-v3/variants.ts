/**
 * Policy variants over stored benchmark runs (docs/design/attention-engine-v3.md
 * §3(5), "Policy v3.2"). No LLM calls: each v3 row's stored facts are replayed
 * (analysis.ts `rescore`) under a candidate rule set and a sender scenario, so
 * a version's parameters are chosen by numbers before it ships.
 *
 * The eval mails carry no relationship or DMARC data. A scenario supplies what
 * the policy would see live; it is an assumption about the senders, not a
 * measurement of them.
 */

import { isAutomatedSender } from "../judge/keyword-policy.js";
import { hasSpamLabel } from "../judge/poc-judge.js";
import type { Tier } from "../judge/tiers.js";
import {
  type DueWindow,
  laneFromFactsUnderRules,
  type PolicyRules,
  type PolicyVersion,
  policyRules,
  RISK_TRUST_MIN_HISTORY_MS,
  RISK_TRUST_MIN_INBOUND,
} from "../judge/v3/policy.js";
import {
  NEW_SENDER,
  type RelationshipSnapshot,
  UNKNOWN_RELATIONSHIP,
} from "../judge/v3/relationship.js";
import type { LaneDecider } from "./analysis.js";
import type { BenchRow, Ratio } from "./metrics.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface SenderView {
  relationship: RelationshipSnapshot | null;
  senderAuthenticated: boolean | null;
}

export interface SenderScenario {
  name: string;
  sender(id: string, decidedAt: Date): SenderView;
}

/** A correspondent v3.1's risk trust accepts once DMARC passes: 3 mails over 30+ days. */
export function knownCorrespondent(decidedAt: Date): RelationshipSnapshot {
  return {
    ...UNKNOWN_RELATIONSHIP,
    vip: false,
    sentCount: 0,
    inboundCount: RISK_TRUST_MIN_INBOUND,
    firstSeenAt: new Date(decidedAt.getTime() - RISK_TRUST_MIN_HISTORY_MS - DAY_MS).toISOString(),
  };
}

const COLD: SenderView = { relationship: NEW_SENDER, senderAuthenticated: null };

/**
 * cold_start: the eval's own view, no history and no verdict: every sender is
 *   new (NEW_SENDER), so under v3.2 every sender is a first contact.
 * known_sender: every sender has mailed the user before, no DMARC verdict.
 *   The gate never fires and risk trust cannot either, so v3.2 equals v3.1.
 * "+ <ids> trusted": as above, but the listed items' senders are known
 *   correspondents whose From passed DMARC, so risk trust can fire for them
 *   (the "eval-046 sender known" reading of the P3 bar).
 */
export function senderScenarios(trustedIds: readonly string[]): SenderScenario[] {
  const trusted = new Set(trustedIds);
  const suffix = ` + ${trustedIds.join(", ")} trusted`;
  const known = (at: Date): SenderView => ({
    relationship: knownCorrespondent(at),
    senderAuthenticated: null,
  });
  const lift =
    (rest: (at: Date) => SenderView) =>
    (id: string, at: Date): SenderView =>
      trusted.has(id)
        ? { relationship: knownCorrespondent(at), senderAuthenticated: true }
        : rest(at);
  return [
    { name: "cold_start", sender: () => COLD },
    { name: `cold_start${suffix}`, sender: lift(() => COLD) },
    { name: "known_sender", sender: (_id, at) => known(at) },
    { name: `known_sender${suffix}`, sender: lift(known) },
  ];
}

export interface PolicyVariant {
  name: string;
  rules(decidedAt: Date): PolicyRules;
}

const fixed = (version: PolicyVersion, name = version): PolicyVariant => ({
  name,
  rules: () => policyRules(version),
});

const withWindow = (name: string, window: (at: Date) => DueWindow): PolicyVariant => ({
  name,
  rules: (at) => ({ ...policyRules("v3.2"), dueWindow: window(at) }),
});

/** End of the business week (Friday 24:00 UTC) holding `at`; on a weekend, the next one. */
export function businessWeekEnd(at: Date, weeksAhead = 0): Date {
  const day = at.getUTCDay(); // 0 Sunday … 6 Saturday
  const toFriday = day === 6 ? 6 : day === 0 ? 5 : 5 - day;
  const friday = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + toFriday);
  return new Date(friday + DAY_MS + weeksAhead * 7 * DAY_MS);
}

const symmetric = (hours: number) => () => ({
  overdueMs: hours * HOUR_MS,
  aheadMs: hours * HOUR_MS,
});
const throughBusinessWeek = (weeksAhead: number) => (at: Date) => ({
  overdueMs: policyRules("v3.2").dueWindow.overdueMs,
  aheadMs: businessWeekEnd(at, weeksAhead).getTime() - at.getTime(),
});

/**
 * v3.1 and v3.2 as shipped, and v3.2 under candidate due windows. The business
 * week variants count days in UTC: the policy has no user time zone, so a
 * shipped version would need one.
 */
export const POLICY_VARIANTS: readonly PolicyVariant[] = [
  fixed("v3.1"),
  fixed("v3.2"),
  {
    name: "v3.2, pay asks only",
    rules: () => ({ ...policyRules("v3.2"), firstContactGate: { payAsk: true, event: false } }),
  },
  withWindow("v3.2 ±48h", symmetric(48)),
  withWindow("v3.2 ±72h", symmetric(72)),
  withWindow("v3.2 same business week", throughBusinessWeek(0)),
  withWindow("v3.2 through next business week", throughBusinessWeek(1)),
];

/** The rescore decider for one variant under one scenario, with live's mailbox signals. */
export function variantDecider(variant: PolicyVariant, scenario: SenderScenario): LaneDecider {
  return (facts, email, id) => {
    const decidedAt = new Date(email.receivedAt);
    const d = laneFromFactsUnderRules(
      {
        facts,
        ...scenario.sender(id, decidedAt),
        spam: hasSpamLabel(email.labels),
        automatedSender: isAutomatedSender(email.from ?? ""),
        decidedAt,
      },
      variant.rules(decidedAt),
    );
    return { lane: d.lane, rule: `${variant.name}:${d.reasons[0]?.code ?? "default"}` };
  };
}

export interface LaneMetrics {
  overall: Ratio;
  pushRecall: Ratio;
  pushPrecision: Ratio;
  silentPrecision: Ratio;
  meetingRecall: Ratio;
  meetingPrecision: Ratio;
}

const count = (rows: readonly BenchRow[], pick: (r: BenchRow) => boolean): Ratio => {
  const pool = rows.filter(pick);
  return { hit: pool.filter((r) => r.truth === r.predicted).length, n: pool.length };
};

export function laneMetrics(rows: readonly BenchRow[]): LaneMetrics {
  return {
    overall: count(rows, () => true),
    pushRecall: count(rows, (r) => r.truth === "PUSH"),
    pushPrecision: count(rows, (r) => r.predicted === "PUSH"),
    silentPrecision: count(rows, (r) => r.predicted === "SILENT"),
    meetingRecall: count(rows, (r) => r.truth === "MEETING"),
    meetingPrecision: count(rows, (r) => r.predicted === "MEETING"),
  };
}

const INTERRUPTS: ReadonlySet<Tier> = new Set(["PUSH", "MEETING"]);

/**
 * Rows a variant got wrong that the base got right on a PUSH or MEETING label,
 * per item id: the cost of a demoting rule. Both lists are the same runs in
 * the same order.
 */
export function demotedCorrect(
  base: readonly BenchRow[],
  variant: readonly BenchRow[],
): Map<string, number> {
  const byId = new Map<string, number>();
  base.forEach((b, i) => {
    const v = variant[i];
    if (!v || v.id !== b.id) throw new Error(`row ${i}: runs are not aligned`);
    if (!INTERRUPTS.has(b.truth) || b.predicted !== b.truth || v.predicted === v.truth) return;
    byId.set(b.id, (byId.get(b.id) ?? 0) + 1);
  });
  return byId;
}
