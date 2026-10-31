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

const MONTH_ABBR = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";

/**
 * Words that state a time. When an ask carries a due date, its evidence must
 * contain one, so a model (or an injected instruction) cannot attach a
 * deadline to an unrelated quote. Applied to normalised (lower-case) text.
 * Digits count only when time-shaped ("Invoice #4821" does not state a time),
 * and ambiguous words ("may", "sun", "wed") only next to a number.
 * Shared with the P1 benchmark scorer.
 */
export const TEMPORAL_RE = new RegExp(
  [
    // 6pm, 6 p.m., 18:00, 3/5, 2026-11-03, 5th, within 3 hours
    "\\b\\d{1,2}(?::\\d{2})?\\s?(?:am|pm|a\\.m\\.|p\\.m\\.)",
    "\\b\\d{1,2}:\\d{2}\\b",
    "\\b\\d{1,2}[/.-]\\d{1,2}\\b",
    "\\b\\d{4}-\\d{2}",
    "\\b\\d{1,2}(?:st|nd|rd|th)\\b",
    "\\b\\d+\\s?(?:minutes?|mins?|hours?|hrs?|days?|weeks?)\\b",
    // Korean numerals with a unit: 6시, 3일, 11월, 2주
    "\\d{1,2}\\s?(?:시|일|월|주)",
    `\\b(?:${MONTH_ABBR})[a-z]*\\.?\\s?\\d{1,2}\\b`,
    `\\b\\d{1,2}\\s(?:${MONTH_ABBR})`,
    "\\b(?:today|tonight|tomorrow|tmrw|eod|eow|cob|asap|urgent|urgently|immediately|midnight|noon|morning|afternoon|evening|deadline|weekend|right now|right away|end of (?:the )?(?:day|week|month)|close of business|this week|next week|this month|next month)\\b",
    "\\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tue|tues|thu|thur|thurs|fri)\\b",
    "\\b(?:january|february|march|april|june|july|august|september|october|november|december)\\b",
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

const LATIN_WORD_CHAR_RE = /[a-z0-9]/;

/** A Latin word may not be cut: "approval" does not verify inside "disapproval".
 * Scripts without spaces between word and particle (Korean) are not checked. */
function onWordBoundary(part: string, at: number, quote: string): boolean {
  const before = part[at - 1] ?? "";
  const after = part[at + quote.length] ?? "";
  const cutsStart = LATIN_WORD_CHAR_RE.test(before) && LATIN_WORD_CHAR_RE.test(quote[0] ?? "");
  const cutsEnd =
    LATIN_WORD_CHAR_RE.test(after) && LATIN_WORD_CHAR_RE.test(quote[quote.length - 1] ?? "");
  return !cutsStart && !cutsEnd;
}

function occursAsWords(part: string, quote: string): boolean {
  for (let at = part.indexOf(quote); at >= 0; at = part.indexOf(quote, at + 1)) {
    if (onWordBoundary(part, at, quote)) return true;
  }
  return false;
}

export function verifyEvidence(evidence: string, haystack: EvidenceHaystack): boolean {
  const n = normaliseForEvidence(evidence);
  if (!longEnough(n)) return false;
  return haystack.parts.some((p) => occursAsWords(p, n));
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
