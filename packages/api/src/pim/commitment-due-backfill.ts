/**
 * Backfill plan for Commitment.dueAt.
 *
 * Every ledger row mined before deterministic due dates has dueAt = null:
 * dueAt only ever came from the flag-gated LLM pass, and the old hint regexes
 * rarely captured wording at all. This re-reads each row the way ingestion now
 * does — stored dueText, else the wording found in its evidence text — against
 * the source email's received time in the user's zone. Pure; the ops script
 * (scripts/backfill-commitment-due-at.ts) loads rows and applies the plan.
 */

import { findDuePhrase, resolveDueText } from "./commitment-due.js";

export interface DueBackfillRow {
  id: string;
  userId: string;
  dueText: string | null;
  evidenceText: string | null;
  createdAt: Date;
  /** The source email's receivedAt; null for non-email rows or a deleted email. */
  sourceReceivedAt: Date | null;
}

export type DueBackfillOutcome = "resolved" | "ambiguous" | "unrecognized" | "noPhrase";

export interface DueBackfillDecision {
  id: string;
  userId: string;
  outcome: DueBackfillOutcome;
  dueAt: Date | null;
  dueText: string | null;
  /** The wording came from evidenceText (the row's dueText was empty). */
  dueTextFromEvidence: boolean;
  usedCreatedAt: boolean;
}

export interface DueBackfillSummary {
  scanned: number;
  resolved: number;
  /** Resolved to a deadline already behind `now`: they surface as overdue. */
  resolvedAlreadyPast: number;
  ambiguous: number;
  unrecognized: number;
  noPhrase: number;
  dueTextFromEvidence: number;
  referenceFromCreatedAt: number;
}

export function planDueBackfill(row: DueBackfillRow, timeZone: string): DueBackfillDecision {
  const dueText = row.dueText ?? (row.evidenceText ? findDuePhrase(row.evidenceText) : null);
  const base = {
    id: row.id,
    userId: row.userId,
    dueText,
    dueTextFromEvidence: row.dueText === null && dueText !== null,
    usedCreatedAt: row.sourceReceivedAt === null,
  };
  if (!dueText) return { ...base, outcome: "noPhrase", dueAt: null };
  const resolution = resolveDueText(dueText, {
    referenceDate: row.sourceReceivedAt ?? row.createdAt,
    timeZone,
  });
  return resolution.status === "resolved"
    ? { ...base, outcome: "resolved", dueAt: resolution.dueAt }
    : { ...base, outcome: resolution.status, dueAt: null };
}

/** Aggregate counts only — safe to print from prod (no ids, wording, or text). */
export function summarizeDueBackfill(
  decisions: readonly DueBackfillDecision[],
  now: Date,
): DueBackfillSummary {
  const count = (keep: (decision: DueBackfillDecision) => boolean) => decisions.filter(keep).length;
  return {
    scanned: decisions.length,
    resolved: count((d) => d.outcome === "resolved"),
    resolvedAlreadyPast: count((d) => d.dueAt !== null && d.dueAt.getTime() < now.getTime()),
    ambiguous: count((d) => d.outcome === "ambiguous"),
    unrecognized: count((d) => d.outcome === "unrecognized"),
    noPhrase: count((d) => d.outcome === "noPhrase"),
    dueTextFromEvidence: count((d) => d.dueTextFromEvidence),
    referenceFromCreatedAt: count((d) => d.usedCreatedAt),
  };
}
