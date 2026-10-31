/**
 * Evidence verification for facts v1 (doc §3(1) rule 1). EVAL-ONLY copy of the
 * P2 spec (`src/judge/v3/evidence.ts`), so P1 and P2 score validity the same way:
 *
 *   normalise = NFKC → strip every Unicode format char (\p{Cf}: zero-width,
 *   BOM, soft hyphen, bidi overrides) → fold curly quotes and dashes →
 *   collapse whitespace (incl. NBSP) → trim → lower-case.
 *
 * Case-insensitive on purpose: models re-capitalise sentence starts. The quote
 * must be at most 300 normalised chars, have ≥2 tokens or ≥8 chars (so "the"
 * cannot verify), and be a substring of the text the model was actually shown
 * (after truncation), never the full stored body.
 *
 * Due binding: an ask's `due` survives only when its evidence contains a
 * temporal token; otherwise the due is nulled (the ask is kept) and the item
 * counts as an escalation trigger.
 */
import type { FactsV1 } from "./facts-schema.js";

const MIN_EVIDENCE_CHARS_SINGLE_TOKEN = 8;
const MIN_EVIDENCE_TOKENS = 2;
const MAX_EVIDENCE_CHARS = 300;

const FORMAT_CHARS_RE = /\p{Cf}/gu;
const SINGLE_QUOTES_RE = /[‘’‚‛]/g;
const DOUBLE_QUOTES_RE = /[“”„‟]/g;
const DASHES_RE = /[‐-―]/g;
const WHITESPACE_RE = /\s+/g;

export function normaliseEvidence(s: string): string {
  return s
    .normalize("NFKC")
    .replace(FORMAT_CHARS_RE, "")
    .replace(SINGLE_QUOTES_RE, "'")
    .replace(DOUBLE_QUOTES_RE, '"')
    .replace(DASHES_RE, "-")
    .replace(WHITESPACE_RE, " ")
    .trim()
    .toLowerCase();
}

/** True when `evidence` is a verbatim (normalised) quote of `haystack`. */
export function verifyEvidence(evidence: string, haystack: string): boolean {
  const quote = normaliseEvidence(evidence);
  if (quote.length > MAX_EVIDENCE_CHARS) return false;
  const tokens = quote.split(" ").filter(Boolean).length;
  if (tokens < MIN_EVIDENCE_TOKENS && quote.length < MIN_EVIDENCE_CHARS_SINGLE_TOKEN) return false;
  return normaliseEvidence(haystack).includes(quote);
}

/** P2's TEMPORAL_RE verbatim (src/judge/v3/evidence.ts), run on normalised, lower-cased text. Bare 시 is excluded on purpose. */
const TEMPORAL_RE = new RegExp(
  [
    "\\d",
    "\\b(?:today|tonight|tomorrow|tmrw|eod|eow|cob|asap|urgent|urgently|immediately|midnight|noon|morning|afternoon|evening|deadline|week|weekend|month|right now|right away|end of (?:the )?(?:day|week|month)|close of business)\\b",
    "\\b(?:mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)\\b",
    "\\b(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\\b",
    "오늘|내일|모레|글피|이번\\s?주|다음\\s?주|주말|[월화수목금토일]요일|오전|오후|정오|자정|까지|마감|기한|긴급|즉시|당장|급히|지금",
  ].join("|"),
  "u",
);

/** True when a quote states a time: a digit, a weekday/month, a relative day, or an urgency word (en/ko). */
export function hasTemporalToken(evidence: string): boolean {
  const quote = normaliseEvidence(evidence);
  return TEMPORAL_RE.test(quote);
}

export interface EvidenceChecked {
  /** Asks whose evidence failed are removed (doc: the fact is dropped); unbound dues are nulled. */
  facts: FactsV1;
  evidenceTotal: number;
  evidenceValid: number;
  /** Kept asks whose due was nulled because the quote states no deadline. */
  dueUnbound: number;
}

/**
 * `fields` are the text fields shown to the model (subject, snippet, body), each
 * checked separately so a quote cannot be stitched across a field boundary.
 */
export function applyEvidenceCheck(facts: FactsV1, fields: readonly string[]): EvidenceChecked {
  const kept = facts.asks.filter((a) => fields.some((f) => verifyEvidence(a.evidence, f)));
  const bound = kept.map((a) =>
    a.due !== null && !hasTemporalToken(a.evidence) ? { ...a, due: null } : a,
  );
  return {
    facts: { ...facts, asks: bound },
    evidenceTotal: facts.asks.length,
    evidenceValid: kept.length,
    dueUnbound: bound.filter((a, i) => a.due === null && kept[i].due !== null).length,
  };
}
