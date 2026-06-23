/**
 * Ontology write-side — persistence + recompute (the prisma-touching half).
 *
 * The pure mapping lives in ontology-proposals.ts; this file wires it to the
 * decision-metrics reader and the OntologyProposal table. `persistProposals` is
 * written against a small ProposalStore interface so its dedup logic ("one OPEN
 * per knob; auto-clear knobs no longer proposed") is unit-testable with a fake.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { getDecisionMetrics } from "./decision-metrics.js";
import {
  type ProposalCandidate,
  proposeThresholdAdjustments,
  signalsFromMetrics,
} from "./ontology-proposals.js";
import { captureError } from "./sentry.js";

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
 * Read the override ledger, compute proposals, and persist them. Returns the
 * computed candidates plus the write counts. Safe to call from the daily
 * calibration job or an admin recompute endpoint.
 */
export async function recomputeOntologyProposals(
  opts: { sinceDays?: number } = {},
): Promise<{ candidates: ProposalCandidate[]; result: PersistResult }> {
  const report = await getDecisionMetrics({ sinceDays: opts.sinceDays });
  const signals = signalsFromMetrics(report.overall);
  const candidates = proposeThresholdAdjustments(signals, { windowDays: report.windowDays });
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
