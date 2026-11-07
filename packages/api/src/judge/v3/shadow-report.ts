/**
 * Disagreement report for the v3 facts shadow (doc §5 "Shadow mode"): v2 lane
 * shown vs the lane policy v3 (laneFromFactsV3, pre-budget) gives the stored
 * facts, plus fallback rate, escalation, evidence drops and cost per day. Pure
 * over stored AttentionFacts rows; reports counts and ids only, never mail text.
 *
 * Rows without LLM facts (factsSource "none") are counted as fallback and not
 * compared: their partial facts do not parse as FactsV1 by design. Pinned
 * senders are excluded: the pin decides both lanes.
 */

import type { LiveTier } from "@klorn/contract";
import { toLiveTier } from "../tiers.js";
import { type FactsV1, parseFactsV1 } from "./facts-schema.js";
import { judgeV3LivePolicyVersion } from "./flags.js";
import { laneFromFactsV3 } from "./policy.js";
import { parseRelationshipSnapshot, type RelationshipSnapshot } from "./relationship.js";

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
  senderAuthenticated?: boolean | null;
}

/** Pre-budget v3 lane for a stored row, or null when a pin decides the lane. */
export function laneForRow(
  facts: FactsV1,
  signals: Signals,
  rel: RelationshipSnapshot | null,
  at: Date,
): LiveTier | null {
  if (rel?.pinned) return null;
  return laneFromFactsV3({
    facts,
    relationship: rel,
    spam: Boolean(signals.spam),
    automatedSender: Boolean(signals.automatedSender || signals.autoSubmitted),
    // The DMARC verdict feeds v3.1's risk trust, as on the live path.
    senderAuthenticated:
      typeof signals.senderAuthenticated === "boolean" ? signals.senderAuthenticated : null,
    decidedAt: at,
    version: judgeV3LivePolicyVersion(),
  }).lane;
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
    const v3 = laneForRow(
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
      policy: judgeV3LivePolicyVersion(),
      compared,
      excludedPinned: pinned,
      agreement: compared ? agreed / compared : null,
      matrix,
      disagreementSamples: samples,
    },
  };
}
