/**
 * Evidence verification for facts v1 (docs/design/attention-engine-v3.md §3(1)):
 * every `evidence` string must be a substring of the normalised subject or
 * body. A fact whose evidence fails is dropped and the item is escalated.
 *
 * Normalisation is shared with the P1 benchmark scorer, so keep it in one place:
 * NFKC → strip format chars (\p{Cf}) → controls to spaces → fold curly quotes
 * and dashes → collapse whitespace → trim → lower-case. Case-insensitive on
 * purpose: models re-capitalise sentence starts, and that alone must not drop
 * a real ask. A quote needs ≥2 tokens or ≥8 chars, so a stray "the" cannot
 * ground a fabricated fact.
 *
 * Subject and body are checked separately, so a quote cannot be stitched
 * across the boundary. The body must be the text actually shown to the model
 * (after truncation), not the full stored body.
 */

import { type FactsV1, MAX_EVIDENCE_CHARS } from "./facts-schema.js";

/** A quote must carry at least this many tokens… */
export const MIN_EVIDENCE_TOKENS = 2;
/** …or, as one token (Korean/Japanese phrases often have no spaces), this many chars. */
export const MIN_EVIDENCE_SINGLE_TOKEN_CHARS = 8;

// Every Unicode format character: zero-width space/joiners, word joiner, BOM,
// soft hyphen, and the bidi embeddings/overrides/isolates that can make a
// quote render differently from its bytes.
const FORMAT_CHARS_RE = /\p{Cf}/gu;
const CONTROL_RE = /\p{Cc}/gu;
const SINGLE_QUOTES_RE = /[\u2018\u2019\u201a\u201b]/g;
const DOUBLE_QUOTES_RE = /[\u201c\u201d\u201e\u201f]/g;
const DASHES_RE = /[\u2010-\u2015]/g;

/**
 * Words that state a time. When an ask carries a due date, its evidence must
 * contain one, so a model (or an injected instruction) cannot attach a
 * deadline to an unrelated quote. Applied to normalised (lower-case) text.
 * Shared with the P1 benchmark scorer.
 */
export const TEMPORAL_RE = new RegExp(
  [
    "\\d",
    "\\b(?:today|tonight|tomorrow|tmrw|eod|eow|cob|asap|urgent|urgently|immediately|midnight|noon|morning|afternoon|evening|deadline|week|weekend|month|right now|right away|end of (?:the )?(?:day|week|month)|close of business)\\b",
    "\\b(?:mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)\\b",
    "\\b(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\\b",
    "오늘|내일|모레|글피|이번\\s?주|다음\\s?주|주말|[월화수목금토일]요일|오전|오후|정오|자정|까지|마감|기한|긴급|즉시|당장|급히|지금",
  ].join("|"),
  "u",
);

export function normaliseForEvidence(s: string): string {
  return s
    .normalize("NFKC")
    .replace(FORMAT_CHARS_RE, "")
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

function longEnough(normalised: string): boolean {
  if (normalised.length > MAX_EVIDENCE_CHARS) return false;
  const tokens = normalised.split(" ").filter(Boolean);
  return (
    tokens.length >= MIN_EVIDENCE_TOKENS || normalised.length >= MIN_EVIDENCE_SINGLE_TOKEN_CHARS
  );
}

export function verifyEvidence(evidence: string, haystack: EvidenceHaystack): boolean {
  const n = normaliseForEvidence(evidence);
  if (!longEnough(n)) return false;
  return haystack.parts.some((p) => p.includes(n));
}

/** The quote states a time (see TEMPORAL_RE). */
export function evidenceStatesTime(evidence: string): boolean {
  return TEMPORAL_RE.test(normaliseForEvidence(evidence));
}

export interface EvidenceDrop {
  path: string;
  evidence: string;
}

export interface EvidenceCheck {
  checked: number;
  dropped: EvidenceDrop[];
}

/**
 * Drop every ask whose evidence is not in the mail, and clear a due date whose
 * evidence states no time (the ask is kept; the clear is reported as a drop so
 * the item escalates). Returns new objects.
 */
export function verifyFactsEvidence(
  facts: FactsV1,
  haystack: EvidenceHaystack,
): { facts: FactsV1; check: EvidenceCheck } {
  const dropped: EvidenceDrop[] = [];
  const asks = facts.asks.flatMap((ask, i) => {
    if (!verifyEvidence(ask.evidence, haystack)) {
      dropped.push({ path: `asks[${i}]`, evidence: ask.evidence });
      return [];
    }
    if (ask.due !== null && !evidenceStatesTime(ask.evidence)) {
      dropped.push({ path: `asks[${i}].due`, evidence: ask.evidence });
      return [{ ...ask, due: null }];
    }
    return [{ ...ask }];
  });
  return {
    facts: { ...facts, asks, risk: [...facts.risk] },
    check: { checked: facts.asks.length, dropped },
  };
}
