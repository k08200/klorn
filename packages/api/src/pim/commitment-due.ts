/**
 * Deterministic due dates for the Commitment Ledger.
 *
 * `findDuePhrase` lifts the deadline wording out of a commitment sentence
 * ("다음 주 월요일 오전 10시까지 공유드릴게요" → "다음 주 월요일 오전 10시");
 * `resolveDueText` turns wording into an instant, read against the source
 * message's received time in the USER's timezone (never the server's).
 *
 * Wording that cannot be read without guessing is "ambiguous" and stores no
 * dueAt: a bare 1–12 hour ("8시", "8:00"), a weekday named on that same
 * weekday, English "next Friday" when "this coming" and "next week's" differ,
 * two different dates, or a deadline before the message itself. Date-only and
 * span wording resolves to the LAST moment it can mean — end of the local day,
 * Sunday for a week, the month's last day — so a deadline is never earlier
 * than the sender meant.
 *
 * No date library: chrono-node has no Korean locale and guesses meridiems,
 * the two things this module exists to get right; time-zone.ts already does
 * the DST-correct wall-clock math.
 */

import {
  localDateKey,
  localDateTimeToUtc,
  localDayOfWeek,
  normalizeTimeZone,
} from "../time-zone.js";
import type { LocalNow } from "./commitment-due-calendar.js";
import { DUE_RULES, type DueRule, END_OF_DAY } from "./commitment-due-rules.js";

export interface DueContext {
  /** When the promise was made — the source email's received time. */
  referenceDate: Date;
  /** The user's IANA zone (AutomationConfig.timezone). */
  timeZone: string;
}

export type DueResolution =
  | { status: "resolved"; dueAt: Date }
  | { status: "ambiguous" }
  | { status: "unrecognized" };

const AMBIGUOUS: DueResolution = { status: "ambiguous" };
const UNRECOGNIZED: DueResolution = { status: "unrecognized" };

const DAY_MS = 86_400_000;
/** No mail promise is tracked more than ~13 months out; further is a misread. */
const MAX_HORIZON_MS = 400 * DAY_MS;
/** dueText is a short phrase; anything longer is not one. */
const MAX_PHRASE_CHARS = 120;
/** Scan bound for findDuePhrase — callers pass one sentence, this caps abuse. */
const MAX_SCAN_CHARS = 2000;
/**
 * What may sit between two parts of one deadline phrase: "tomorrow at 3pm",
 * "월요일에 오전 10시", "11/15(금) 오후 3시". Range and choice words join too
 * ("월요일부터 금요일", "Friday or Monday") so the phrase reads as ambiguous
 * instead of resolving to its first, earlier, part.
 */
const GAP_RE =
  /^[\s,]*(?:\([^()]{1,5}\)[\s,]*)?(?:(?:at|on|by|before|until|through|thru|to|and|or|에|부터|까지|이나|나|또는|혹은|~|-|–)[\s,]*)?$/i;
const MAX_GAP_CHARS = 12;

interface Hit {
  rule: DueRule;
  match: RegExpMatchArray;
  start: number;
  end: number;
}

/** Every rule match, overlaps dropped: the earliest, then longest, match wins. */
function findHits(text: string): Hit[] {
  const all = DUE_RULES.flatMap((rule) =>
    [...text.matchAll(rule.re)]
      .filter((match) => rule.accept?.(match) ?? true)
      .map((match) => {
        const start = match.index ?? 0;
        return { rule, match, start, end: start + match[0].length };
      }),
  );
  const ordered = [...all].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Hit[] = [];
  for (const hit of ordered) {
    const last = kept[kept.length - 1];
    if (!last || hit.start >= last.end) kept.push(hit);
  }
  return kept;
}

/** Hits grouped into phrases: consecutive hits joined only by GAP_RE text. */
function phrasesOf(source: string, hits: Hit[]): Hit[][] {
  const runs: Hit[][] = [];
  for (const hit of hits) {
    const run = runs[runs.length - 1];
    const previous = run?.[run.length - 1];
    const gap = previous ? source.slice(previous.end, hit.start) : null;
    if (run && gap !== null && gap.length <= MAX_GAP_CHARS && GAP_RE.test(gap)) run.push(hit);
    else runs.push([hit]);
  }
  return runs;
}

/**
 * The deadline wording in a commitment sentence, as written: the first phrase
 * with a real deadline part (a lone past-day or "3/4" marker is skipped).
 * Null when there is none. Stored as dueText even when it does not resolve
 * ("8시").
 */
export function findDuePhrase(text: string): string | null {
  return findDuePhrases(text)[0] ?? null;
}

/**
 * Every deadline phrase in the text, in order — findDuePhrase's candidates, for
 * a reader that picks among them (an event prefers the one naming a clock time).
 */
export function findDuePhrases(text: string): string[] {
  return findDueSpans(text).map((span) => span.phrase);
}

/** findDuePhrases with where each phrase sits in `text` (start and end offsets). */
export function findDueSpans(text: string): Array<{ phrase: string; start: number; end: number }> {
  const source = text.slice(0, MAX_SCAN_CHARS);
  return phrasesOf(source, findHits(source))
    .filter((run) => run.some((hit) => hit.rule.standalone !== false))
    .map((run) => {
      const raw = source.slice(run[0].start, run[run.length - 1].end);
      const phrase = raw.trim();
      const start = run[0].start + (raw.length - raw.trimStart().length);
      return { phrase, start, end: start + phrase.length };
    });
}

/** undefined = no such part; null = parts that disagree or cannot be read. */
function agree<T>(values: Array<T | null>): T | null | undefined {
  if (values.length === 0) return undefined;
  const first = values[0];
  return values.every((value) => value !== null && value === first) ? first : null;
}

function readParts(hits: Hit[], now: LocalNow) {
  return {
    day: agree(
      hits.flatMap(({ rule, match }) => (rule.kind === "day" ? [rule.resolve(match, now)] : [])),
    ),
    time: agree(
      hits.flatMap(({ rule, match }) => (rule.kind === "time" ? [rule.resolve(match)] : [])),
    ),
    span: agree(
      hits.flatMap(({ rule, match }) => (rule.kind === "span" ? [rule.resolve(match, now)] : [])),
    ),
  };
}

/** The deadline instant, or null when the parts conflict or one cannot be read. */
function combine(hits: Hit[], now: LocalNow): number | null {
  const { day, time, span } = readParts(hits, now);
  if (day === null || time === null || span === null) return null;
  if (span !== undefined) return day === undefined && time === undefined ? span : null;
  if (day === undefined && time === undefined) return null;
  return localDateTimeToUtc(day ?? now.dateKey, time ?? END_OF_DAY, now.timeZone).getTime();
}

function isWithinHorizon(atMs: number, refMs: number): boolean {
  return atMs >= refMs && atMs <= refMs + MAX_HORIZON_MS;
}

/** The reference moment in the user's zone; null when it is not a real instant. */
function localNowOf(ctx: DueContext): LocalNow | null {
  const refMs = ctx.referenceDate.getTime();
  if (!Number.isFinite(refMs)) return null;
  const timeZone = normalizeTimeZone(ctx.timeZone);
  return {
    dateKey: localDateKey(ctx.referenceDate, timeZone),
    dow: localDayOfWeek(ctx.referenceDate, timeZone),
    refMs,
    timeZone,
  };
}

/** One recognized part of a phrase, read against the reference moment. */
export interface DuePart {
  kind: DueRule["kind"];
  /** The wording the part was read from, as written. */
  text: string;
  /** day: `YYYY-MM-DD`; time: `HH:MM`; span: an instant (ms). null: recognized, not readable. */
  value: string | number | null;
}

/**
 * Each part of a phrase read on its own, overlaps dropped — for a reader that
 * needs a day and a clock time apart rather than one deadline instant (an
 * event's start, pim/event-when.ts). Empty when nothing is recognized or the
 * reference moment is not a real instant.
 */
export function duePartsOf(phrase: string, ctx: DueContext): DuePart[] {
  const now = localNowOf(ctx);
  if (!now) return [];
  return findHits(phrase.slice(0, MAX_PHRASE_CHARS)).map(({ rule, match }) => ({
    kind: rule.kind,
    text: match[0],
    value: rule.kind === "time" ? rule.resolve(match) : rule.resolve(match, now),
  }));
}

/** Read deadline wording against when it was written, in the user's zone. */
export function resolveDueText(text: string, ctx: DueContext): DueResolution {
  const phrase = text.trim();
  if (phrase.length === 0) return UNRECOGNIZED;
  // Too long to be a deadline phrase: veto rather than defer to an LLM date.
  if (phrase.length > MAX_PHRASE_CHARS) return AMBIGUOUS;
  const hits = findHits(phrase);
  if (hits.length === 0) return UNRECOGNIZED;
  const now = localNowOf(ctx);
  if (!now) return AMBIGUOUS;
  const atMs = combine(hits, now);
  if (atMs === null || !isWithinHorizon(atMs, now.refMs)) return AMBIGUOUS;
  return { status: "resolved", dueAt: new Date(atMs) };
}

/**
 * The ledger's dueAt. The deterministic reading of `dueText` wins; wording it
 * finds ambiguous vetoes the LLM's date (that is where the 20:00 guess for
 * "8시" would come from); only wording it does not recognize at all falls back
 * to the LLM's date, and only when that date is plausible for the message.
 */
export function pickDueAt(
  dueText: string | null,
  llmDueAt: Date | null,
  ctx: DueContext,
): Date | null {
  if (!dueText) return null;
  const resolution = resolveDueText(dueText, ctx);
  if (resolution.status === "resolved") return resolution.dueAt;
  if (resolution.status === "ambiguous" || !llmDueAt) return null;
  return isWithinHorizon(llmDueAt.getTime(), ctx.referenceDate.getTime()) ? llmDueAt : null;
}
