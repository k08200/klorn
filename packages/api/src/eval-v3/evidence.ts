/**
 * Evidence checks for the P1 benchmark: a thin adapter over the P2 extractor's
 * rules (`src/judge/v3/evidence.ts`, #1587), so P1 scores exactly what
 * production enforces. P2 owns normalisation, the quote weight, word edges and
 * TEMPORAL_RE; this file only adds what the harness needs:
 *  - a haystack with one part per text field shown to the model (subject,
 *    snippet, body). The gate set has no bodies, so the snippet must count.
 *  - the counts the report prints (valid / total quotes, unbound dues).
 */
import {
  type EvidenceHaystack,
  normaliseForEvidence,
  verifyFactsEvidence,
} from "../judge/v3/evidence.js";
import type { FactsV1 } from "../judge/v3/facts-schema.js";

/** One normalised part per non-empty field: a quote can never span two fields. */
export function evidenceHaystack(fields: readonly string[]): EvidenceHaystack {
  return { parts: fields.map(normaliseForEvidence).filter((p) => p.length > 0) };
}

export interface EvidenceChecked {
  /** Asks whose evidence failed are removed; dues whose quote states no time are nulled. */
  facts: FactsV1;
  evidenceTotal: number;
  evidenceValid: number;
  /** Kept asks whose due was nulled because the quote states no deadline. */
  dueUnbound: number;
}

export function applyEvidenceCheck(facts: FactsV1, fields: readonly string[]): EvidenceChecked {
  const { facts: checked, check } = verifyFactsEvidence(facts, evidenceHaystack(fields));
  const dueUnbound = check.dropped.filter((d) => d.path.endsWith(".due")).length;
  const droppedAsks = check.dropped.length - dueUnbound;
  return {
    facts: checked,
    evidenceTotal: check.checked,
    evidenceValid: check.checked - droppedAsks,
    dueUnbound,
  };
}
