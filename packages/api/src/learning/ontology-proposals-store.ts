/**
 * Ontology write-side — persistence + recompute (the prisma-touching half).
 *
 * The pure mapping lives in ontology-proposals.ts; this file wires it to the
 * decision-metrics reader and the OntologyProposal table. `persistProposals` is
 * written against a small ProposalStore interface so its dedup logic ("one OPEN
 * per knob; auto-clear knobs no longer proposed") is unit-testable with a fake.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { getDecisionMetrics } from "../decision-metrics.js";
import type { ScoredOutcome } from "../selective-threshold.js";
import { captureError } from "../sentry.js";
import { getEffectiveThresholds } from "./ontology-overrides.js";
import {
  type ProposalCandidate,
  proposeAutoConfidenceAdjustment,
  proposeThresholdAdjustments,
  signalsFromMetrics,
} from "./ontology-proposals.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Map raw AUTO DecisionLabel rows to (confidence, correct) for the risk-coverage
 * calibrator. Pure. Unconfirmed rows (no outcome) are dropped — honest-by-design:
 * a null outcome is never counted as agreement. `correct` = the user did NOT
 * override the AUTO decision. Rows without a numeric confidence feature are
 * skipped rather than coerced.
 */
export function toAutoScoredOutcomes(
  rows: ReadonlyArray<{ features: unknown; outcome: string | null }>,
): ScoredOutcome[] {
  const out: ScoredOutcome[] = [];
  for (const row of rows) {
    if (!row.outcome) continue;
    const features = row.features as { confidence?: unknown } | null;
    const confidence = features?.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) continue;
    out.push({ confidence, correct: !row.outcome.startsWith("OVERRIDE:") });
  }
  return out;
}

/** Minimal persistence surface, so persistProposals can be tested with a fake. */
export interface ProposalStore {
  findOpenByKnob(knob: string): Promise<{ id: string } | null>;
  updateOpen(id: string, candidate: ProposalCandidate): Promise<void>;
  createOpen(candidate: ProposalCandidate): Promise<void>;
  /**
   * Dismiss OPEN proposals whose knob is NOT in `keepKnobs` (signal recovered).
   * An empty `keepKnobs` is intentional and dismisses ALL OPEN proposals (every
   * signal is healthy) — do NOT add an early-return guard for the empty case.
   */
  dismissOpenExcept(keepKnobs: readonly string[]): Promise<number>;
}

export interface PersistResult {
  written: number;
  dismissed: number;
}

/**
 * Reconcile the OPEN proposal set with the freshly computed candidates: update
 * or create one OPEN row per proposed knob, and dismiss any OPEN proposal whose
 * signal has recovered (knob no longer proposed). Pure over the store.
 */
export async function persistProposals(
  candidates: readonly ProposalCandidate[],
  store: ProposalStore,
): Promise<PersistResult> {
  let written = 0;
  for (const candidate of candidates) {
    const existing = await store.findOpenByKnob(candidate.knob);
    if (existing) {
      await store.updateOpen(existing.id, candidate);
    } else {
      await store.createOpen(candidate);
    }
    written += 1;
  }
  const dismissed = await store.dismissOpenExcept(candidates.map((c) => c.knob));
  return { written, dismissed };
}

/** Prisma-backed ProposalStore. */
export const prismaProposalStore: ProposalStore = {
  async findOpenByKnob(knob) {
    return prisma.ontologyProposal.findFirst({
      where: { knob, status: "OPEN" },
      select: { id: true },
    });
  },
  async updateOpen(id, c) {
    await prisma.ontologyProposal.update({
      where: { id },
      data: {
        currentValue: c.currentValue,
        proposedValue: c.proposedValue,
        direction: c.direction,
        evidence: c.evidence as unknown as Prisma.InputJsonValue,
      },
    });
  },
  async createOpen(c) {
    await prisma.ontologyProposal.create({
      data: {
        knob: c.knob,
        currentValue: c.currentValue,
        proposedValue: c.proposedValue,
        direction: c.direction,
        evidence: c.evidence as unknown as Prisma.InputJsonValue,
        status: "OPEN",
      },
    });
  },
  async dismissOpenExcept(keepKnobs) {
    const res = await prisma.ontologyProposal.updateMany({
      where: { status: "OPEN", knob: { notIn: [...keepKnobs] } },
      data: { status: "DISMISSED" },
    });
    return res.count;
  },
};

/**
 * Read confirmed AUTO decisions (outcome stamped) with their judge features,
 * windowed like the metrics reader. Bounded to a recent sample so calibration
 * tracks current behaviour, not ancient history.
 */
async function readAutoDecisionRows(
  sinceDays?: number,
): Promise<Array<{ features: unknown; outcome: string | null }>> {
  const where: { shownTier: string; outcome: { not: null }; judgedAt?: { gte: Date } } = {
    shownTier: "AUTO",
    outcome: { not: null },
  };
  if (sinceDays && sinceDays > 0) {
    where.judgedAt = { gte: new Date(Date.now() - sinceDays * DAY_MS) };
  }
  return prisma.decisionLabel.findMany({
    where: where as unknown as Prisma.DecisionLabelWhereInput,
    select: { features: true, outcome: true },
    take: 5000,
  });
}

/**
 * Read the override ledger, compute proposals, and persist them. Returns the
 * computed candidates plus the write counts. Safe to call from the daily
 * calibration job or an admin recompute endpoint.
 */
export async function recomputeOntologyProposals(
  opts: { sinceDays?: number } = {},
): Promise<{ candidates: ProposalCandidate[]; result: PersistResult }> {
  const report = await getDecisionMetrics({ sinceDays: opts.sinceDays });
  const signals = signalsFromMetrics(report.overall);
  // Propose against the LIVE effective thresholds, not the git base const: once
  // an override is approved, currentValue must reflect what the classifier
  // actually runs on, or the proposal re-suggests an already-applied change.
  const thresholds = getEffectiveThresholds();
  const candidates = proposeThresholdAdjustments(signals, {
    thresholds,
    windowDays: report.windowDays,
  });

  // AUTO confidence is calibrated separately, per-row (risk-coverage over the
  // AUTO decisions' confidence + override outcome) — the aggregate metrics above
  // don't carry the per-decision scores it needs.
  const autoRows = toAutoScoredOutcomes(await readAutoDecisionRows(opts.sinceDays));
  const autoProposal = proposeAutoConfidenceAdjustment(autoRows, {
    thresholds,
    windowDays: report.windowDays,
  });
  if (autoProposal) candidates.push(autoProposal);

  const result = await persistProposals(candidates, prismaProposalStore);
  return { candidates, result };
}

/** Best-effort recompute for fire-and-forget callers (daily job). Never throws. */
export async function recomputeOntologyProposalsSafe(
  opts: { sinceDays?: number } = {},
): Promise<void> {
  try {
    const { candidates, result } = await recomputeOntologyProposals(opts);
    console.log(
      `[ontology] proposals recomputed: ${candidates.length} active, ${result.dismissed} dismissed`,
    );
  } catch (err) {
    console.error("[ontology] proposal recompute failed", err);
    captureError(err, { tags: { scope: "ontology.recompute" } });
  }
}

/** OPEN proposals for the inspector / admin surface (most recent first). */
export async function listOpenProposals() {
  return prisma.ontologyProposal.findMany({
    where: { status: "OPEN" },
    orderBy: { updatedAt: "desc" },
  });
}

/** APPLIED proposals = the live overrides the classifier is reading (for Revert). */
export async function listAppliedProposals() {
  return prisma.ontologyProposal.findMany({
    where: { status: "APPLIED" },
    orderBy: { updatedAt: "desc" },
  });
}
