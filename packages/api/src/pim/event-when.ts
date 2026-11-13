/**
 * When a mail's event happens, for the "Add to calendar" smart action
 * (routes/smart-actions.ts). The date and the clock time come from the
 * Commitment Ledger's deterministic rules (commitment-due.ts, #1717), read
 * apart: an event needs a start, not a deadline's last moment. Wording that
 * cannot be read without guessing becomes a question the confirm card asks —
 * never a guessed value. A bare 1–12 hour ("3시", "8:00") asks AM or PM; a day
 * with no clock time asks for the time; a time with no day asks for the day.
 *
 * Pure: no I/O. The phrase and the quote are untrusted mail text; nothing here
 * runs them through a model.
 */

import { type DueContext, type DuePart, duePartsOf } from "./commitment-due.js";

export type EventQuestion =
  | { kind: "meridiem"; am: string; pm: string }
  | { kind: "time" }
  | { kind: "date" }
  | { kind: "when" };

export interface EventWhen {
  /** `YYYY-MM-DD` in the user's zone; null when the mail does not say which day. */
  date: string | null;
  /** `HH:MM` (24h) in the user's zone; null when it does not say, or says ambiguously. */
  time: string | null;
  /** What the user must answer before saving; null when date and time are both read. */
  question: EventQuestion | null;
}

const WHEN: EventWhen = { date: null, time: null, question: { kind: "when" } };

/** A part that names a clock time, as opposed to a part of the day ("afternoon", "EOD"). */
const CLOCK_WORDING = /\d|\bnoon\b|\bmidday\b|정오/i;
/** "3시", "3시 30분", "3시 반" with no 오전/오후 before it. */
const BARE_KO_HOUR = /^(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분|\s*(반))?$/;
/** "8:00" with no am/pm after it. */
const BARE_EN_CLOCK = /^(\d{1,2}):(\d{2})$/;

const pad2 = (value: number) => String(value).padStart(2, "0");

/** AM/PM readings of a bare 1–12 hour; null when the wording is not one. */
function meridiemOptions(text: string): { am: string; pm: string } | null {
  const ko = BARE_KO_HOUR.exec(text.trim());
  const en = ko ? null : BARE_EN_CLOCK.exec(text.trim());
  const match = ko ?? en;
  if (!match) return null;
  const hour = Number.parseInt(match[1], 10);
  const minute = ko
    ? ko[3]
      ? 30
      : Number.parseInt(ko[2] ?? "0", 10)
    : Number.parseInt(match[2], 10);
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  const amHour = hour === 12 ? 0 : hour;
  const pmHour = hour === 12 ? 12 : hour + 12;
  return { am: `${pad2(amHour)}:${pad2(minute)}`, pm: `${pad2(pmHour)}:${pad2(minute)}` };
}

/** The one value every part agrees on; null when any is unreadable or two differ. */
function agreed(parts: DuePart[]): string | null {
  const values = parts.map((part) => part.value);
  const first = values[0];
  if (typeof first !== "string") return null;
  return values.every((value) => value === first) ? first : null;
}

function questionFor(date: string | null, time: string | null): EventQuestion | null {
  if (date && time) return null;
  if (date) return { kind: "time" };
  if (time) return { kind: "date" };
  return { kind: "when" };
}

/** Read an event's day and clock time from deadline wording, asking where it would guess. */
export function readEventWhen(phrase: string | null, ctx: DueContext): EventWhen {
  const wording = phrase?.trim() ?? "";
  if (wording === "") return WHEN;
  const parts = duePartsOf(wording, ctx);
  // A span ("within 3 days") is a deadline, never an event's start.
  if (parts.length === 0 || parts.some((part) => part.kind === "span")) return WHEN;

  const days = parts.filter((part) => part.kind === "day");
  const date = days.length > 0 ? agreed(days) : null;
  const clocks = parts.filter((part) => part.kind === "time" && CLOCK_WORDING.test(part.text));

  if (clocks.length === 1 && clocks[0].value === null) {
    const options = meridiemOptions(clocks[0].text);
    if (options) return { date, time: null, question: { kind: "meridiem", ...options } };
  }
  const time = clocks.length > 0 ? agreed(clocks) : null;
  return { date, time, question: questionFor(date, time) };
}

// ─── Clock times the card cannot apply ───────────────────────────────────

/** "3-4pm", "2 to 4pm", "3시부터 4시": the clock read is a range's end, not the start. */
const RANGE_BEFORE = /\d(?::\d{2})?\s*(?:[ap]\.?m\.?\s*)?(?:-|–|—|~|to|until|till|부터|에서)\s*$/i;
/** "3pm PST", "15:00 (UTC+1)", "10am CET": a clock in a zone the card does not convert. */
const ZONE_AFTER = /^\s*\(?\s*(?:[A-Z]{2,4}T\b|UTC|GMT|Z\b|[+-]\d{2}:?\d{2}\b)/;
/** The common abbreviations in any case ("3pm pst"); a closed list, so "3pm next" is not one. */
const NAMED_ZONE_AFTER = /^\s*\(?\s*(?:[pmce][sd]t|gmt|utc|bst|cest?|eest|jst|kst|aes?t|aedt)\b/i;
const CONTEXT_CHARS = 16;

/**
 * Drop a clock time the mail qualifies in a way the card cannot apply — the
 * end of a range, or another time zone — and ask for the time instead. The
 * quote still shows the wording, so the user can read it.
 */
export function withClockContext(
  when: EventWhen,
  text: string,
  span: { start: number; end: number },
): EventWhen {
  if (when.time === null && when.question?.kind !== "meridiem") return when;
  const before = text.slice(Math.max(0, span.start - CONTEXT_CHARS), span.start);
  const after = text.slice(span.end, span.end + CONTEXT_CHARS);
  const zoned = ZONE_AFTER.test(after) || NAMED_ZONE_AFTER.test(after);
  if (!RANGE_BEFORE.test(before) && !zoned) return when;
  return { date: when.date, time: null, question: when.date ? { kind: "time" } : { kind: "when" } };
}

// ─── Source quote and title ───────────────────────────────────────────────

const MAX_QUOTE_CHARS = 300;
const MAX_TITLE_CHARS = 120;
/** Sentence ends: Latin punctuation before whitespace, CJK punctuation, or a blank line. */
// One punctuation mark per match (a run would rescan on every failed lookahead).
const SENTENCE_END = /[.!?](?=\s|$)|[。！？]|\n\s*\n/g;
const REPLY_PREFIX =
  /^\s*(?:(?:re|fwd?|fw|aw|wg|tr|答复|回复|转发|회신|답장|전달)\s*(?:\[\d+\]\s*)?[:：]\s*)+/i;

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** The window of `sentence` (at most MAX_QUOTE_CHARS) that keeps `phrase` in view. */
function windowAround(sentence: string, phrase: string): string {
  if (sentence.length <= MAX_QUOTE_CHARS) return sentence;
  const at = Math.max(0, sentence.indexOf(phrase));
  const room = MAX_QUOTE_CHARS - 2;
  const start = Math.max(
    0,
    Math.min(at - Math.floor((room - phrase.length) / 2), sentence.length - room),
  );
  const end = Math.min(sentence.length, start + room);
  return `${start > 0 ? "…" : ""}${sentence.slice(start, end).trim()}${end < sentence.length ? "…" : ""}`;
}

/**
 * The sentence of `text` that holds `phrase`, whitespace collapsed and capped,
 * so the confirm card can show what the date was read from — verbatim.
 */
export function quoteAround(text: string, phrase: string, phraseStart?: number): string {
  const at =
    phraseStart !== undefined && text.startsWith(phrase, phraseStart)
      ? phraseStart
      : text.indexOf(phrase);
  if (at < 0) return windowAround(collapse(text), collapse(phrase));
  const phraseEnd = at + phrase.length;
  let start = 0;
  let end = text.length;
  for (const match of text.matchAll(SENTENCE_END)) {
    const index = match.index ?? 0;
    if (index + match[0].length <= at) {
      start = index + match[0].length;
    } else if (index >= phraseEnd) {
      end = match[0].trim() === "" ? index : index + match[0].length;
      break;
    }
  }
  return windowAround(collapse(text.slice(start, end)), collapse(phrase));
}

/** The mail's subject as an event title: reply/forward prefixes off, length capped. */
export function eventTitleFromSubject(subject: string): string {
  return collapse(subject.replace(REPLY_PREFIX, "")).slice(0, MAX_TITLE_CHARS);
}
