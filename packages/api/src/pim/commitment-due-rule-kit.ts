/**
 * Shared types and readers for the due-date rules (commitment-due-rules-ko.ts,
 * commitment-due-rules-en.ts). A rule recognizes one component of a deadline
 * — a day, a time of day, or a relative span — and reads it against the
 * reference moment in the user's zone. A reader returns null when the wording
 * is recognized but cannot be read without guessing.
 */

import { localDateTimeToUtc } from "../time-zone.js";
import {
  type LocalNow,
  plusDays,
  upcomingMonthDay,
  validDateKey,
} from "./commitment-due-calendar.js";

export type Match = RegExpMatchArray;

interface RuleBase {
  /** Global; every pattern must stay linear (it runs over untrusted mail text). */
  re: RegExp;
  accept?: (m: Match) => boolean;
  /**
   * false: a marker that is never a deadline on its own — a past or recurring
   * day ("last Friday", "매주 월요일"), a numeric date like "3/4". It only
   * matters attached to a real deadline part, where it makes the phrase
   * ambiguous instead of letting the other part resolve alone.
   */
  standalone?: false;
}

export type DueRule =
  | (RuleBase & { kind: "day"; resolve: (m: Match, now: LocalNow) => string | null })
  | (RuleBase & { kind: "time"; resolve: (m: Match) => string | null })
  | (RuleBase & { kind: "span"; resolve: (m: Match, now: LocalNow) => number | null });

/** A date-only deadline means the end of that local day. */
export const END_OF_DAY = "23:59";
/** "오전" / "morning" without an hour: the morning's last moment. */
export const END_OF_MORNING = "12:00";
const HOUR_MS = 3_600_000;

export function int(value: string | undefined): number {
  return Number.parseInt(value ?? "", 10);
}

export function hhmm(hour: number | null, minute: number): string | null {
  if (hour === null || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function monthDay(
  now: LocalNow,
  month: number,
  day: number,
  year: string | undefined,
): string | null {
  return year ? validDateKey(int(year), month, day) : upcomingMonthDay(now, month, day);
}

/** Relative span → instant: hours are exact, days and weeks end at local end of day. */
export function spanMs(count: number, unit: string, now: LocalNow): number | null {
  if (!Number.isFinite(count) || count < 1) return null;
  if (/^(시간|hours?|hrs?)$/i.test(unit)) return now.refMs + count * HOUR_MS;
  const days = /^(주|weeks?)$/i.test(unit) ? count * 7 : count;
  return localDateTimeToUtc(plusDays(now, days), END_OF_DAY, now.timeZone).getTime();
}

/** Recognized, never resolved: the reader for past and recurring markers. */
export function never(): null {
  return null;
}

/**
 * "11/15": month/day only when the day is over 12 — then no day/month reading
 * exists. "5/6", "3/4", "24/7" are ambiguous. A marker (not standalone): a
 * lone fraction never becomes a deadline.
 */
export const SLASH_DATE_RULE: DueRule = {
  kind: "day",
  re: /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?![\d/])/g,
  standalone: false,
  resolve: (m, now) => (int(m[2]) > 12 ? monthDay(now, int(m[1]), int(m[2]), m[3]) : null),
};
