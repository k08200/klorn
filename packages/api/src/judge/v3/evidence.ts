/**
 * Evidence verification for facts v1 (docs/design/attention-engine-v3.md §3(1)):
 * every `evidence` string must be a substring of the normalised subject or
 * body. A fact whose evidence fails is dropped and the item is escalated.
 *
 * Normalisation is shared with the P1 benchmark scorer, so keep it in one place:
 * NFKC → strip zero-width/BOM/soft hyphen → fold curly quotes and dashes →
 * collapse whitespace → trim → lower-case. Case-insensitive on purpose: models
 * re-capitalise sentence starts, and that alone must not drop a real ask.
 *
 * Subject and body are checked separately, so a quote cannot be stitched
 * across the boundary. The body must be the text actually shown to the model
 * (after truncation), not the full stored body.
 */

import type { FactsV1 } from "./facts-schema.js";

export const MIN_EVIDENCE_CHARS = 3;
export const MAX_EVIDENCE_NORMALISED_CHARS = 300;

const ZERO_WIDTH_RE = /[​-‍⁠﻿­]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are folded to spaces.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const SINGLE_QUOTES_RE = /[‘’‚‛]/g;
const DOUBLE_QUOTES_RE = /[“”„‟]/g;
const DASHES_RE = /[‐-―]/g;

export function normaliseForEvidence(s: string): string {
  return s
    .normalize("NFKC")
    .replace(ZERO_WIDTH_RE, "")
    .replace(CONTROL_RE, " ")
    .replace(SINGLE_QUOTES_RE, "'")
    .replace(DOUBLE_QUOTES_RE, '"')
    .replace(DASHES_RE, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Normalised subject and body, kept apart. Build once per item. */
export interface EvidenceHaystack {
  readonly parts: readonly string[];
}

export function buildEvidenceHaystack(
  subject: string | null | undefined,
  body: string | null | undefined,
): EvidenceHaystack {
  return {
    parts: [normaliseForEvidence(subject ?? ""), normaliseForEvidence(body ?? "")].filter(
      (p) => p.length > 0,
    ),
  };
}

export function verifyEvidence(evidence: string, haystack: EvidenceHaystack | string): boolean {
  const n = normaliseForEvidence(evidence);
  if (n.length < MIN_EVIDENCE_CHARS || n.length > MAX_EVIDENCE_NORMALISED_CHARS) return false;
  const parts = typeof haystack === "string" ? [normaliseForEvidence(haystack)] : haystack.parts;
  return parts.some((p) => p.includes(n));
}

export interface EvidenceDrop {
  path: string;
  evidence: string;
}

export interface EvidenceCheck {
  checked: number;
  dropped: EvidenceDrop[];
}

/** Drop every ask whose evidence is not in the mail. Returns new objects. */
export function verifyFactsEvidence(
  facts: FactsV1,
  haystack: EvidenceHaystack,
): { facts: FactsV1; check: EvidenceCheck } {
  const dropped: EvidenceDrop[] = [];
  const asks = facts.asks.filter((ask, i) => {
    if (verifyEvidence(ask.evidence, haystack)) return true;
    dropped.push({ path: `asks[${i}]`, evidence: ask.evidence });
    return false;
  });
  return {
    facts: { ...facts, asks: asks.map((a) => ({ ...a })), risk: [...facts.risk] },
    check: { checked: facts.asks.length, dropped },
  };
}
