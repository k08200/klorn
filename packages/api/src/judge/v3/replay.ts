/**
 * Policy replay (docs/design/attention-engine-v3.md §5 "Policy replay"):
 * re-run a policy version over stored mail and diff it against what v2 showed,
 * offline and with no LLM call. Pure: the CLI (scripts/replay-policy.ts) loads
 * rows and prints this report.
 *
 * Per row:
 *  - facts: the stored facts (AttentionFacts, P2) when present, else keyword facts;
 *  - precedence: a manual override, a pin, the marketing fast-path, a sender
 *    prior or a learned rule keeps the v2 lane, as in the live judge;
 *  - interrupt budget: PUSH lanes are admitted per user per local day by
 *    importance, then arrival; the rest are held in QUEUE.
 * Parity re-checks principle 9 on real mail: keyword facts through v3 against
 * the real v2 keyword fallback.
 */

import type { LiveTier } from "@klorn/contract";
import type { ClassifiableEmail } from "../email-classifier.js";
import { isAutomatedSender, isClearMarketing } from "../keyword-policy.js";
import { hasSpamLabel, keywordFallbackJudgement } from "../poc-judge.js";
import { toLiveTier } from "../tiers.js";
import { importancePrior } from "./importance.js";
import { allocateInterruptBudget, localDayKey } from "./interrupt-budget.js";
import { keywordFactsV1 } from "./keyword-facts.js";
import { classifyParityDivergence, parityViolation } from "./parity.js";
import { laneFromFactsV3, POLICY_VERSION, type PolicyDecision } from "./policy.js";
import type { FactsV1, RelationshipSnapshot } from "./policy-types.js";
import { type ReasonCode, reason } from "./reasons.js";

export const LIVE_LANES: readonly LiveTier[] = ["PUSH", "MEETING", "QUEUE", "INFO", "SILENT"];

/** v2 judge sources that short-circuit before facts, mapped to their reason code. */
const PRECEDENCE_SOURCES: Readonly<Record<string, ReasonCode>> = {
  "pinned-rule": "pinned",
  "fast-path": "kind",
  "sender-prior": "sender_pattern",
  "learned-rule": "learned_rule",
};

export interface ReplayRow {
  id: string;
  userId: string;
  receivedAt: Date;
  /** The user's AutomationConfig.timezone (the budget's local day). */
  timeZone: string;
  /** The lane v2 shows today (AttentionItem.tier). */
  v2Tier: LiveTier;
  /** The v2 judge source (DecisionLabel.decidedBy), or null. */
  v2Source: string | null;
  manualOverride: boolean;
  email: ClassifiableEmail;
  stored: { facts: FactsV1; relationship: RelationshipSnapshot | null } | null;
}

export type LaneCounts = Record<LiveTier, number>;

export interface ReplayChange {
  id: string;
  userId: string;
  receivedAt: string;
  v2: LiveTier;
  v3: LiveTier;
  held: boolean;
  reasonCodes: ReasonCode[];
  factsSource: "stored" | "keyword";
}

export interface ReplayReport {
  policyVersion: string;
  items: number;
  users: number;
  factsSource: { stored: number; keyword: number };
  precedenceKept: number;
  lanes: { v2: LaneCounts; v3PreBudget: LaneCounts; v3: LaneCounts };
  transitions: Record<string, number>;
  budget: {
    limit: number | null;
    candidates: number;
    admitted: number;
    held: number;
    /** Ids held by the budget (also the ones whose v2 lane was already QUEUE). */
    heldIds: string[];
    userDaysWithCandidates: number;
    maxCandidatesPerUserDay: number;
    userDaysOverBudget: number;
  };
  parity: {
    compared: number;
    v2Keyword: LaneCounts;
    v3Keyword: LaneCounts;
    violations: Record<"hidden" | "lostPush" | "machinePush" | "newPush", number>;
    divergences: Record<string, number>;
  };
  changes: ReplayChange[];
}

const emptyCounts = (): LaneCounts => ({ PUSH: 0, MEETING: 0, QUEUE: 0, INFO: 0, SILENT: 0 });
const bump = <K extends string>(rec: Record<K, number>, key: K): void => {
  rec[key] = (rec[key] ?? 0) + 1;
};

interface Decided {
  row: ReplayRow;
  decision: PolicyDecision;
  importance: number;
  precedence: boolean;
  /** Spends the interrupt budget when PUSH: not a pin, not a manual override (as live). */
  budgeted: boolean;
}

export function replayPolicy(
  rows: readonly ReplayRow[],
  opts: { budget: number | null },
): ReplayReport {
  const decided = rows.map(decideRow);
  const heldIds = simulateBudget(decided, opts.budget);
  return {
    policyVersion: POLICY_VERSION,
    items: rows.length,
    users: new Set(rows.map((r) => r.userId)).size,
    factsSource: {
      stored: rows.filter((r) => r.stored).length,
      keyword: rows.filter((r) => !r.stored).length,
    },
    precedenceKept: decided.filter((d) => d.precedence).length,
    lanes: laneTotals(decided, heldIds),
    transitions: transitionsOf(decided, heldIds),
    budget: budgetSummary(decided, heldIds, opts.budget),
    parity: parityOf(rows),
    changes: changesOf(decided, heldIds),
  };
}

function decideRow(row: ReplayRow): Decided {
  const facts = row.stored?.facts ?? keywordFactsV1(row.email, row.receivedAt);
  const relationship = row.stored?.relationship ?? null;
  const importance = importancePrior(relationship, row.receivedAt);
  const precedenceCode = row.v2Source ? PRECEDENCE_SOURCES[row.v2Source] : undefined;
  if (precedenceCode && row.v2Source !== "pinned-rule") {
    const decision: PolicyDecision = {
      lane: row.v2Tier,
      reasons: [reason(precedenceCode, { params: { tier: row.v2Tier } })],
      policyVersion: POLICY_VERSION,
      pushCandidate: false,
    };
    return { row, decision, importance, precedence: true, budgeted: true };
  }
  const decision = laneFromFactsV3({
    facts,
    relationship,
    pinnedTier: row.v2Source === "pinned-rule" ? row.v2Tier : null,
    manualOverrideTier: row.manualOverride ? row.v2Tier : null,
    spam: hasSpamLabel(row.email.labels),
    automatedSender: isAutomatedSender(row.email.from || ""),
    decidedAt: row.receivedAt,
  });
  const precedence = row.manualOverride || row.v2Source === "pinned-rule";
  return { row, decision, importance, precedence, budgeted: !precedence };
}

/**
 * PUSH lanes spend budget as on the live push path: pins and manual overrides
 * do not. Not modelled: quiet hours, preferences and the 6h recency rule (live
 * pushes those skip spend nothing), so replay can only overstate `held`.
 */
function simulateBudget(decided: readonly Decided[], limit: number | null): Set<string> {
  const byUserDay = new Map<string, Decided[]>();
  for (const d of decided) {
    if (d.decision.lane !== "PUSH" || !d.budgeted) continue;
    const key = `${d.row.userId}|${localDayKey(d.row.receivedAt, d.row.timeZone).dayKey}`;
    byUserDay.set(key, [...(byUserDay.get(key) ?? []), d]);
  }
  const held = new Set<string>();
  for (const group of byUserDay.values()) {
    const candidates = group.map((d) => ({
      id: d.row.id,
      importance: d.importance,
      receivedAt: d.row.receivedAt,
    }));
    for (const id of allocateInterruptBudget(candidates, { used: 0, limit }).held) held.add(id);
  }
  return held;
}

const finalLane = (d: Decided, held: Set<string>): LiveTier =>
  held.has(d.row.id) ? "QUEUE" : d.decision.lane;

function laneTotals(decided: readonly Decided[], held: Set<string>): ReplayReport["lanes"] {
  const lanes = { v2: emptyCounts(), v3PreBudget: emptyCounts(), v3: emptyCounts() };
  for (const d of decided) {
    bump(lanes.v2, d.row.v2Tier);
    bump(lanes.v3PreBudget, d.decision.lane);
    bump(lanes.v3, finalLane(d, held));
  }
  return lanes;
}

function transitionsOf(decided: readonly Decided[], held: Set<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of decided) bump(out, `${d.row.v2Tier}→${finalLane(d, held)}`);
  return out;
}

function budgetSummary(
  decided: readonly Decided[],
  held: Set<string>,
  limit: number | null,
): ReplayReport["budget"] {
  const perUserDay = new Map<string, number>();
  for (const d of decided) {
    if (d.decision.lane !== "PUSH" || !d.budgeted) continue;
    const key = `${d.row.userId}|${localDayKey(d.row.receivedAt, d.row.timeZone).dayKey}`;
    perUserDay.set(key, (perUserDay.get(key) ?? 0) + 1);
  }
  const counts = [...perUserDay.values()];
  const candidates = counts.reduce((a, b) => a + b, 0);
  return {
    limit,
    candidates,
    admitted: candidates - held.size,
    held: held.size,
    heldIds: decided.filter((d) => held.has(d.row.id)).map((d) => d.row.id),
    userDaysWithCandidates: counts.length,
    maxCandidatesPerUserDay: counts.length ? Math.max(...counts) : 0,
    userDaysOverBudget: limit === null ? 0 : counts.filter((n) => n > limit).length,
  };
}

function parityOf(rows: readonly ReplayRow[]): ReplayReport["parity"] {
  const parity: ReplayReport["parity"] = {
    compared: 0,
    v2Keyword: emptyCounts(),
    v3Keyword: emptyCounts(),
    violations: { hidden: 0, lostPush: 0, machinePush: 0, newPush: 0 },
    divergences: {},
  };
  for (const row of rows) {
    const facts = keywordFactsV1(row.email, row.receivedAt);
    const spam = hasSpamLabel(row.email.labels);
    const v2 = isClearMarketing(row.email)
      ? "SILENT"
      : toLiveTier(keywordFallbackJudgement(row.email).tier);
    const v3 = laneFromFactsV3({ facts, relationship: null, spam, decidedAt: row.receivedAt });
    parity.compared++;
    bump(parity.v2Keyword, v2);
    bump(parity.v3Keyword, v3.lane);
    const violation = parityViolation({
      v2,
      v3: v3.lane,
      v3PushCandidate: v3.pushCandidate,
      facts,
      spam,
    });
    if (violation) parity.violations[violation]++;
    const cls = classifyParityDivergence(v2, v3.lane, facts);
    if (cls) bump(parity.divergences, `${cls}: ${v2}→${v3.lane}`);
  }
  return parity;
}

function changesOf(decided: readonly Decided[], held: Set<string>): ReplayChange[] {
  return decided
    .filter((d) => d.row.v2Tier !== finalLane(d, held))
    .map((d) => ({
      id: d.row.id,
      userId: d.row.userId,
      receivedAt: d.row.receivedAt.toISOString(),
      v2: d.row.v2Tier,
      v3: finalLane(d, held),
      held: held.has(d.row.id),
      reasonCodes: held.has(d.row.id)
        ? ["held_budget", ...d.decision.reasons.map((r) => r.code)]
        : d.decision.reasons.map((r) => r.code),
      factsSource: d.row.stored ? "stored" : "keyword",
    }));
}
