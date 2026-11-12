/**
 * Which ledger rows count as real commitments rather than suggestions.
 *
 * The rule extractor writes every row at 0.45 or 0.55 (commitment-ingestion.ts
 * confidenceForCandidate) — deliberately below anything the user has vouched
 * for. Such a row is a suggestion: the web ledger lists it under "To confirm"
 * and it may never interrupt. It becomes a commitment when the user confirms
 * it (confirmedAt) or when it was extracted with confidence >= 0.7 (an LLM
 * refinement, or a row the user created). Pure.
 */

/** The same bar the web ledger used before suggestions were listed at all. */
export const COMMITMENT_CONFIRMED_MIN_CONFIDENCE = 0.7;

export interface ConfirmableCommitment {
  confidence: number;
  confirmedAt?: Date | null;
}

export function isConfirmedCommitment(row: ConfirmableCommitment): boolean {
  return row.confirmedAt != null || row.confidence >= COMMITMENT_CONFIRMED_MIN_CONFIDENCE;
}
