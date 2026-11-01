/**
 * Disagreement report for the v3 facts shadow (doc §5 "Shadow mode"): v2 lane
 * shown vs the lane the stored facts imply, plus fallback rate, escalation,
 * evidence drops and cost per day. Pure over stored AttentionFacts rows;
 * reports counts and ids only, never mail text.
 *
 * The facts→lane mapping here is doc §3(4) WITHOUT budget, ranking or
 * importance, with the P3 safety rules already agreed (machine mail never
 * PUSHes through an ask, risk-only PUSH needs vip, phishing_suspect and spam
 * veto PUSH/MEETING). It is a stand-in until judge/v3/policy.ts
 * (laneFromFactsV3, phase P3) lands; then this file imports that instead.
 */

import { type LiveTier, toLiveTier } from "../tiers.js";
import { type FactsV1, parseFactsV1 } from "./facts-schema.js";
import { parseRelationshipSnapshot, type RelationshipSnapshot } from "./relationship.js";

export const REPORT_LANE_POLICY = "doc-3.4-pre-budget (stand-in until P3 policy.ts)";
const DAY_MS = 86_400_000;
const PUSH_DUE_WINDOW_MS = DAY_MS;
/** An overdue deadline older than this is not "due soon". */
const PUSH_OVERDUE_MS = DAY_MS;
const MAX_SAMPLES = 20;

export interface ShadowRow {
  sourceId: string;
  factsSource: string;
  facts: unknown;
  signals: unknown;
  relationship: unknown;
  v2Tier: string | null;
  escalate: boolean;
  escalateReasons: string[];
  evidenceCheck: unknown;
  costUsd: number | null;
  model: string | null;
  provider: string | null;
  extractedAt: Date;
}

interface Signals {
  spam?: boolean;
  automatedSender?: boolean;
  autoSubmitted?: boolean;
}

const URGENT_RISKS = ["payment_failed", "security_alert"] as const;

/** Pre-budget lane implied by facts, or null when a pin decides the lane. */
export function laneFromFactsForReport(
  facts: FactsV1,
  signals: Signals,
  rel: RelationshipSnapshot | null,
  at: Date,
): LiveTier | null {
  if (rel?.pinned) return null;
  const phishing = facts.risk.includes("phishing_suspect");
  const machine = Boolean(signals.automatedSender || signals.autoSubmitted);
  const blocked = Boolean(signals.spam) || phishing;
  const direct = facts.addressedTo === "me_direct" || facts.addressedTo === "me_cc";
  const dueSoon = facts.asks.some((a) => {
    if (a.due === null) return false;
    const delta = Date.parse(a.due) - at.getTime();
    return delta <= PUSH_DUE_WINDOW_MS && delta >= -PUSH_OVERDUE_MS;
  });
  const urgentRisk = facts.risk.some((r) => (URGENT_RISKS as readonly string[]).includes(r));
  // Doc §3(4): both PUSH branches need the mail addressed to the user.
  if (!blocked && direct && ((dueSoon && !machine) || (urgentRisk && rel?.vip === true))) {
    return "PUSH";
  }
  if (facts.event && facts.addressedTo !== "bulk" && !blocked) return "MEETING";
  const personal = facts.kind === "personal" || facts.kind === "work_thread";
  if (facts.asks.length > 0 || personal || facts.threadTurn === "mine_to_reply" || urgentRisk) {
    return "QUEUE";
  }
  const record = facts.kind === "notification" || facts.kind === "receipt";
  if ((facts.transaction && !facts.transaction.actionRequired) || record) return "INFO";
  if (facts.addressedTo === "bulk" || facts.kind === "newsletter" || facts.kind === "promotion") {
    return "SILENT";
  }
  return "QUEUE";
}

function asSignals(raw: unknown): Signals {
  return typeof raw === "object" && raw !== null ? (raw as Signals) : {};
}

function droppedPaths(raw: unknown): string[] {
  const dropped = (raw as { dropped?: unknown } | null)?.dropped;
  return Array.isArray(dropped)
    ? dropped.map((d) => String((d as { path?: unknown })?.path ?? ""))
    : [];
}

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

export function summarizeShadow(rows: readonly ShadowRow[]) {
  const bySource: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  const models: Record<string, number> = {};
  const costPerDay: Record<string, number> = {};
  const matrix: Record<string, Record<string, number>> = {};
  const samples: { sourceId: string; v2: LiveTier; v3: LiveTier }[] = [];
  let invalid = 0;
  let escalated = 0;
  let asksDropped = 0;
  let dueCleared = 0;
  let compared = 0;
  let agreed = 0;
  let pinned = 0;

  for (const row of rows) {
    bump(bySource, row.factsSource);
    if (row.escalate) escalated++;
    for (const r of row.escalateReasons) bump(reasons, r);
    if (row.model) bump(models, `${row.provider ?? "?"}/${row.model}`);
    if (row.costUsd !== null)
      bump(costPerDay, row.extractedAt.toISOString().slice(0, 10), row.costUsd);
    for (const path of droppedPaths(row.evidenceCheck)) {
      if (path.endsWith(".due")) dueCleared++;
      else asksDropped++;
    }
    if (row.factsSource !== "llm" || row.v2Tier === null) continue;
    const parsed = parseFactsV1(row.facts).facts;
    if (!parsed) {
      invalid++;
      continue;
    }
    const v3 = laneFromFactsForReport(
      parsed,
      asSignals(row.signals),
      parseRelationshipSnapshot(row.relationship),
      row.extractedAt,
    );
    if (v3 === null) {
      pinned++;
      continue;
    }
    const v2 = toLiveTier(row.v2Tier);
    matrix[v2] = matrix[v2] ?? {};
    bump(matrix[v2], v3);
    compared++;
    if (v2 === v3) agreed++;
    else if (samples.length < MAX_SAMPLES) samples.push({ sourceId: row.sourceId, v2, v3 });
  }

  const totalUsd = Object.values(costPerDay).reduce((a, b) => a + b, 0);
  return {
    rows: rows.length,
    bySource,
    fallbackRate: rows.length ? (bySource.none ?? 0) / rows.length : null,
    invalidStoredFacts: invalid,
    escalation: { rate: rows.length ? escalated / rows.length : null, reasons },
    evidence: { asksDropped, dueCleared },
    cost: { totalUsd, perDayUsd: costPerDay },
    models,
    lanes: {
      policy: REPORT_LANE_POLICY,
      compared,
      excludedPinned: pinned,
      agreement: compared ? agreed / compared : null,
      matrix,
      disagreementSamples: samples,
    },
  };
}
