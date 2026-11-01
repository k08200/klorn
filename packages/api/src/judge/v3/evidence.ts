/**
 * Evidence verification for facts v1 (docs/design/attention-engine-v3.md §3(1)):
 * every `evidence` string must be a substring of the normalised subject or
 * body. A fact whose evidence fails is dropped and the item is escalated.
 *
 * Normalisation is shared with the P1 benchmark scorer, so keep it in one place:
 * NFKC → strip format chars (\p{Cf}) → controls to spaces → fold curly quotes
 * and dashes → collapse whitespace → trim → lower-case. Case-insensitive on
 * purpose: models re-capitalise sentence starts, and that alone must not drop
 * a real ask. A quote must weigh ≥8 (Hangul/CJK chars count 2, spaces 0), so
 * a stray "of the" cannot ground a fabricated fact.
 *
 * Subject and body are checked separately, so a quote cannot be stitched
 * across the boundary. The body must be the text actually shown to the model
 * (after truncation), not the full stored body.
 */

import { type FactsV1, MAX_EVIDENCE_CHARS } from "./facts-schema.js";

/** A quote must weigh at least this much: one per Latin character, two per
 * Hangul/CJK character (denser scripts say more per character), so "of the"
 * fails while "please confirm" and "회신 부탁" pass. */
export const MIN_EVIDENCE_WEIGHT = 8;
const DENSE_SCRIPT_RE = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

// Every Unicode format character: zero-width space/joiners, word joiner, BOM,
// soft hyphen, and the bidi embeddings/overrides/isolates that can make a
// quote render differently from its bytes.
const FORMAT_CHARS_RE = /\p{Cf}/gu;
const CONTROL_RE = /\p{Cc}/gu;
const SINGLE_QUOTES_RE = /[\u2018\u2019\u201a\u201b]/g;
const DOUBLE_QUOTES_RE = /[\u201c\u201d\u201e\u201f]/g;
const DASHES_RE = /[\u2010-\u2015]/g;

const MONTH =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

/**
 * Words that state a time. When an ask carries a due date, its evidence must
 * contain one, so a model (or an injected instruction) cannot attach a
 * deadline to an unrelated quote. Applied to normalised (lower-case) text.
 * Digits count only when time-shaped ("Invoice #4821" does not state a time),
 * and ambiguous words ("may", "sun", "wed") only next to a number or a
 * preposition. Covers the product's mail languages (en, ko, ja, zh, de, fr, es,
 * pt); a quote in another language loses its due and escalates rather than
 * keeping an unverified one. Shared with the P1 benchmark scorer.
 */
export const TEMPORAL_RE = new RegExp(
  [
    // Numbers shaped like times and dates: 6pm, 18:00, 3/5, 2026-11-03, 5th,
    // within 3 hours, by 5, Q4, 6시, 3日, 11月, 2週
    "\\b\\d{1,2}(?::\\d{2})?\\s?(?:am|pm|a\\.m\\.|p\\.m\\.)",
    "\\b\\d{1,2}[:h]\\d{2}\\b",
    "\\b\\d{1,2}[/.-]\\d{1,2}\\b",
    "\\b\\d{4}-\\d{2}",
    "\\b\\d{1,2}(?:st|nd|rd|th)\\b",
    "\\b\\d+\\s?(?:minutes?|mins?|hours?|hrs?|days?|weeks?|stunden?|tage?|heures?|jours?|horas?|d[ií]as?)\\b",
    "\\b(?:by|at|before|until|till|on)\\s\\d{1,2}\\b",
    "\\bq[1-4]\\b",
    "\\d{1,2}\\s?(?:시|일|월|주|時|日|月|週|号|號)",
    `\\b(?:${MONTH})\\.?\\s?\\d{1,2}\\b`,
    `\\b\\d{1,2}\\.?\\s(?:${MONTH})\\b`,
    // English words
    "\\b(?:today|tonight|tomorrow|tmrw|eod|eow|cob|asap|urgent|urgently|immediately|midnight|noon|morning|afternoon|evening|deadline|weekend|right now|right away|end of (?:the )?(?:day|week|month)|close of business|this week|next week|this month|next month)\\b",
    "\\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tue|tues|thu|thur|thurs|fri)\\b",
    "\\b(?:by|on|until|till|before|next|this)\\s(?:mon|wed|sat|sun)\\b",
    "\\b(?:january|february|march|april|june|july|august|september|october|november|december)\\b",
    // German, French, Spanish, Portuguese
    // (Unicode-aware word edges: \\b is ASCII-only and fails next to ü, ã, é.)
    "(?<![\\p{L}\\p{N}])(?:heute|morgen|übermorgen|frist|dringend|sofort|montag|dienstag|mittwoch|donnerstag|freitag|aujourd'hui|demain|délai|lundi|mardi|mercredi|jeudi|vendredi|hoy|mañana|plazo|urgente|lunes|martes|miércoles|jueves|viernes|hoje|amanhã|prazo|segunda-feira|sexta-feira)(?![\\p{L}\\p{N}])",
    // Korean
    "오늘|내일|모레|글피|이번\\s?주|다음\\s?주|주말|[월화수목금토일]요일|오전|오후|정오|자정|까지|마감|기한|긴급|즉시|당장|급히|지금",
    // Japanese, Chinese
    "今日|本日|明日|明後日|今週|来週|今月|来月|[月火水木金土日]曜|午前|午後|までに|まで|期限|締切|締め切り|至急|今天|明天|后天|後天|本周|下周|下週|截止|尽快|盡快",
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
  let weight = 0;
  for (const ch of normalised) {
    if (ch !== " ") weight += DENSE_SCRIPT_RE.test(ch) ? 2 : 1;
  }
  return weight >= MIN_EVIDENCE_WEIGHT;
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
