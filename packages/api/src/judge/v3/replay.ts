/**
 * Policy replay (docs/design/attention-engine-v3.md §5 "Policy replay"):
 * re-run a policy version over stored mail and diff it against what v2 showed,
 * offline and with no LLM call. Pure: the CLI (scripts/replay-policy.ts) loads
 * rows and prints this report.
 *
 * Per row, the live rule (live-decision.ts), so replay shows what the live
 * path would do:
 *  - precedence: a manual override, a pin, the marketing fast-path, a sender
 *    prior or a learned rule keeps the v2 lane;
 *  - facts: stored LLM facts (AttentionFacts) go to the policy; without them
 *    the v2 lane stands, or keyword facts when v2 itself fell back to
 *    keywords. `facts: "keyword"` gives every row keyword facts instead (the
 *    model-down estimate);
 *  - interrupt budget: PUSH lanes are admitted per user per local day by
 *    importance, then arrival, strangers up to their share; the rest are held
 *    in QUEUE.
 * Parity re-checks principle 9 on real mail: keyword facts through v3 against
 * the real v2 keyword fallback.
 */

import type { LiveTier } from "@klorn/contract";
import type { ClassifiableEmail } from "../email-classifier.js";
import { isAutomatedSender, isClearMarketing } from "../keyword-policy.js";
import { hasSpamLabel, keywordFallbackJudgement } from "../poc-judge.js";
import { toLiveTier } from "../tiers.js";
import type { StoredFacts } from "./facts-store.js";
import { allocateInterruptBudget, localDayKey } from "./interrupt-budget.js";
import { keywordFactsV1 } from "./keyword-facts.js";
import {
  basisFromStored,
  decideLiveLane,
  type FactsBasis,
  type LiveDecision,
} from "./live-decision.js";
import { classifyParityDivergence, parityViolation } from "./parity.js";
import { laneFromFactsV3, POLICY_VERSION } from "./policy.js";
import type { RelationshipSnapshot } from "./policy-types.js";
import type { ReasonCode } from "./reasons.js";

export const LIVE_LANES: readonly LiveTier[] = ["PUSH", "MEETING", "QUEUE", "INFO", "SILENT"];

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
  /** The stored AttentionFacts row, read back (facts-store.ts parseStoredFacts). */
  stored: StoredFacts | null;
  /**
   * The sender's relationship when no stored row carries one, loaded by the CLI
   * as the live path loads it for a budgeted PUSH (trust for the slot reserve).
   */
  relationship?: RelationshipSnapshot | null;
}

/** "stored": the live rule per row. "keyword": keyword facts for every row. */
export type ReplayFactsMode = "stored" | "keyword";

export type LaneCounts = Record<LiveTier, number>;

export interface ReplayChange {
  id: string;
  userId: string;
  receivedAt: string;
  v2: LiveTier;
  v3: LiveTier;
  held: boolean;
  reasonCodes: ReasonCode[];
  /** What decided: LLM facts, keyword facts, or the v2 lane. */
  basis: LiveDecision["basis"];
}

export interface ReplayReport {
  policyVersion: string;
  items: number;
  users: number;
  factsMode: ReplayFactsMode;
  /** Rows with a stored facts row, and with LLM facts in it. */
  storedFacts: { rows: number; llm: number };
  /** What decided each row: LLM facts, keyword facts, or the v2 lane. */
  basis: Record<LiveDecision["basis"], number>;
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
  decision: LiveDecision;
}

export function replayPolicy(
  rows: readonly ReplayRow[],
  opts: { budget: number | null; facts?: ReplayFactsMode },
): ReplayReport {
  const factsMode = opts.facts ?? "stored";
  const decided = rows.map((row) => decideRow(row, factsMode));
  const heldIds = simulateBudget(decided, opts.budget);
  const basis = { llm: 0, keyword: 0, v2: 0 };
  for (const d of decided) basis[d.decision.basis]++;
  return {
    policyVersion: POLICY_VERSION,
    items: rows.length,
    users: new Set(rows.map((r) => r.userId)).size,
    factsMode,
    storedFacts: {
      rows: rows.filter((r) => r.stored).length,
      llm: rows.filter((r) => r.stored?.factsSource === "llm" && r.stored.facts).length,
    },
    basis,
    precedenceKept: decided.filter((d) => d.decision.precedence).length,
    lanes: laneTotals(decided, heldIds),
    transitions: transitionsOf(decided, heldIds),
    budget: budgetSummary(decided, heldIds, opts.budget),
    parity: parityOf(rows),
    changes: changesOf(decided, heldIds),
  };
}

function decideRow(row: ReplayRow, mode: ReplayFactsMode): Decided {
  const relationship = row.stored?.relationship ?? row.relationship ?? null;
  const basis: FactsBasis =
    mode === "keyword"
      ? { kind: "keyword", pre: row.stored?.pre ?? null, relationship }
      : { ...basisFromStored(row.stored), relationship };
  const auth = row.stored?.signals?.senderAuthenticated;
  const decision = decideLiveLane({
    v2Tier: row.v2Tier,
    v2Source: row.v2Source,
    manualOverride: row.manualOverride,
    email: row.email,
    receivedAt: row.receivedAt,
    basis,
    // Replay decides each mail as ingest would have, at its arrival.
    decidedAt: row.receivedAt,
    senderAuthenticated: typeof auth === "boolean" ? auth : undefined,
  });
  return { row, decision };
}

/**
 * PUSH lanes spend budget as on the live push path: pins and manual overrides
 * do not. Not modelled: quiet hours, preferences and the 6h recency rule (live
 * pushes those skip spend nothing), so replay can only overstate `held`.
 */
function simulateBudget(decided: readonly Decided[], limit: number | null): Set<string> {
  const byUserDay = new Map<string, Decided[]>();
  for (const d of decided) {
    if (d.decision.lane !== "PUSH" || !d.decision.budgeted) continue;
    const key = `${d.row.userId}|${localDayKey(d.row.receivedAt, d.row.timeZone).dayKey}`;
    byUserDay.set(key, [...(byUserDay.get(key) ?? []), d]);
  }
  const held = new Set<string>();
  for (const group of byUserDay.values()) {
    const candidates = group.map((d) => ({
      id: d.row.id,
      importance: d.decision.importance,
      receivedAt: d.row.receivedAt,
      trusted: d.decision.trusted,
    }));
    for (const id of allocateInterruptBudget(candidates, { limit }).held) held.add(id);
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
    if (d.decision.lane !== "PUSH" || !d.decision.budgeted) continue;
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
      basis: d.decision.basis,
    }));
}
