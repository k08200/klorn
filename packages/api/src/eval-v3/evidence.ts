/**
 * Evidence verification for facts v1 (doc §3(1) rule 1). EVAL-ONLY mirror of
 * the P2 extractor's `src/judge/v3/evidence.ts` (#1587), so P1 and P2 score
 * validity the same way; switch to importing it once #1587 is on main.
 *
 *   normalise = NFKC → strip format chars (\p{Cf}) → controls to spaces → fold
 *   curly quotes and dashes → collapse whitespace → trim → lower-case.
 *
 * Case-insensitive on purpose: models re-capitalise sentence starts. A quote
 * must weigh ≥8 (one per Latin character, two per Hangul/CJK character, spaces
 * zero), be at most 300 chars, never cut a Latin word, and be a substring of
 * one field the model was actually shown (after truncation), never the full
 * stored body. Fields are checked separately: no stitching across them.
 *
 * Due binding: an ask's `due` survives only when its evidence states a time
 * (TEMPORAL_RE); otherwise the due is nulled (the ask is kept) and the item
 * counts as an escalation trigger.
 */
import type { FactsV1 } from "./facts-schema.js";

const MIN_EVIDENCE_WEIGHT = 8;
const MAX_EVIDENCE_CHARS = 300;
const DENSE_SCRIPT_RE = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

const FORMAT_CHARS_RE = /\p{Cf}/gu;
const CONTROL_RE = /\p{Cc}/gu;
const SINGLE_QUOTES_RE = /[‘’‚‛]/g;
const DOUBLE_QUOTES_RE = /[“”„‟]/g;
const DASHES_RE = /[‐-―]/g;

const MONTH =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

/** P2's TEMPORAL_RE verbatim (#1587). Applied to normalised, lower-cased text. */
const TEMPORAL_RE = new RegExp(
  [
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
    "\\b(?:today|tonight|tomorrow|tmrw|eod|eow|cob|asap|urgent|urgently|immediately|midnight|noon|morning|afternoon|evening|deadline|weekend|right now|right away|end of (?:the )?(?:day|week|month)|close of business|this week|next week|this month|next month)\\b",
    "\\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tue|tues|thu|thur|thurs|fri)\\b",
    "\\b(?:by|on|until|till|before|next|this)\\s(?:mon|wed|sat|sun)\\b",
    "\\b(?:january|february|march|april|june|july|august|september|october|november|december)\\b",
    "(?<![\\p{L}\\p{N}])(?:heute|morgen|übermorgen|frist|dringend|sofort|montag|dienstag|mittwoch|donnerstag|freitag|aujourd'hui|demain|délai|lundi|mardi|mercredi|jeudi|vendredi|hoy|mañana|plazo|urgente|lunes|martes|miércoles|jueves|viernes|hoje|amanhã|prazo|segunda-feira|sexta-feira)(?![\\p{L}\\p{N}])",
    "오늘|내일|모레|글피|이번\\s?주|다음\\s?주|주말|[월화수목금토일]요일|오전|오후|정오|자정|까지|마감|기한|긴급|즉시|당장|급히|지금",
    "今日|本日|明日|明後日|今週|来週|今月|来月|[月火水木金土日]曜|午前|午後|までに|まで|期限|締切|締め切り|至急|今天|明天|后天|後天|本周|下周|下週|截止|尽快|盡快",
  ].join("|"),
  "u",
);

export function normaliseEvidence(s: string): string {
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

function longEnough(normalised: string): boolean {
  if (normalised.length > MAX_EVIDENCE_CHARS) return false;
  let weight = 0;
  for (const ch of normalised) {
    if (ch !== " ") weight += DENSE_SCRIPT_RE.test(ch) ? 2 : 1;
  }
  return weight >= MIN_EVIDENCE_WEIGHT;
}

const LATIN_WORD_CHAR_RE = /[a-z0-9]/;

/** A Latin word may not be cut; scripts without spaces before particles (Korean) are not checked. */
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

/** True when `evidence` is a verbatim (normalised, whole-word) quote of one field. */
export function verifyEvidence(evidence: string, field: string): boolean {
  const quote = normaliseEvidence(evidence);
  if (!longEnough(quote)) return false;
  return occursAsWords(normaliseEvidence(field), quote);
}

/** True when a quote states a time (time-shaped number, weekday/month, relative day, urgency word). */
export function hasTemporalToken(evidence: string): boolean {
  return TEMPORAL_RE.test(normaliseEvidence(evidence));
}

export interface EvidenceChecked {
  /** Asks whose evidence failed are removed (doc: the fact is dropped); unbound dues are nulled. */
  facts: FactsV1;
  evidenceTotal: number;
  evidenceValid: number;
  /** Kept asks whose due was nulled because the quote states no deadline. */
  dueUnbound: number;
}

/** `fields` are the text fields shown to the model (subject, snippet, body), each checked separately. */
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
