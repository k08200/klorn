/**
 * Calendar arithmetic for commitment due dates, on `YYYY-MM-DD` keys in the
 * user's timezone. Every function returns a new key — or null when the date
 * it would name does not exist or cannot be chosen without guessing.
 */

import { addDaysToDateKey } from "../time-zone.js";

/** The reference moment, read in the user's zone. `dow`: 0 = Sunday … 6 = Saturday. */
export interface LocalNow {
  dateKey: string;
  dow: number;
  refMs: number;
  timeZone: string;
}

const DAY_MS = 86_400_000;
/** A past month/day rolls into next year only when that is at most ~6 months out. */
const NEXT_YEAR_WINDOW_DAYS = 183;

function parts(dateKey: string): { year: number; month: number; day: number } {
  const [year, month, day] = dateKey.split("-").map((part) => Number.parseInt(part, 10));
  return { year, month, day };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** `YYYY-MM-DD` for a real calendar date, else null (Feb 30, month 13, day 0). */
export function validDateKey(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1) return null;
  if (date.getUTCDate() !== day) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function daysBetween(fromKey: string, toKey: string): number {
  const from = parts(fromKey);
  const to = parts(toKey);
  return Math.round(
    (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) /
      DAY_MS,
  );
}

export function plusDays(now: LocalNow, days: number): string {
  return addDaysToDateKey(now.dateKey, days);
}

/** Weeks run Monday–Sunday (ISO). `weeksAhead` 0 = this week, 1 = next. */
export function dayOfWeek(now: LocalNow, dow: number, weeksAhead: number): string {
  const monday = addDaysToDateKey(now.dateKey, -((now.dow + 6) % 7));
  return addDaysToDateKey(monday, weeksAhead * 7 + ((dow + 6) % 7));
}

/** Sunday closes the week, so "this week" never ends before the sender meant. */
export function endOfWeek(now: LocalNow, weeksAhead: number): string {
  return dayOfWeek(now, 0, weeksAhead);
}

/** Next occurrence of `dow`. The reference day's own weekday is today or a week out: null. */
export function upcomingWeekday(now: LocalNow, dow: number): string | null {
  const delta = (dow - now.dow + 7) % 7;
  return delta === 0 ? null : plusDays(now, delta);
}

/** Last day of the month `monthsAhead` from the reference month. */
export function endOfMonth(now: LocalNow, monthsAhead: number): string {
  const { year, month } = parts(now.dateKey);
  return lastDayKey(year, month + monthsAhead);
}

function lastDayKey(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0));
  return `${last.getUTCFullYear()}-${pad2(last.getUTCMonth() + 1)}-${pad2(last.getUTCDate())}`;
}

/** Last day of a named month ("12월 말"), with the same year rule as upcomingMonthDay. */
export function endOfNamedMonth(now: LocalNow, month: number): string | null {
  if (month < 1 || month > 12) return null;
  const { year } = parts(now.dateKey);
  const thisYear = lastDayKey(year, month);
  if (thisYear >= now.dateKey) return thisYear;
  const nextYear = lastDayKey(year + 1, month);
  return daysBetween(now.dateKey, nextYear) > NEXT_YEAR_WINDOW_DAYS ? null : nextYear;
}

/**
 * A month/day without a year: this year's if still ahead, next year's if that
 * is within ~6 months (December mail about "January 5"), otherwise null — a
 * date a few days past is a typo or a missed deadline, not next year's.
 */
export function upcomingMonthDay(now: LocalNow, month: number, day: number): string | null {
  const { year } = parts(now.dateKey);
  const thisYear = validDateKey(year, month, day);
  if (thisYear && thisYear >= now.dateKey) return thisYear;
  const nextYear = validDateKey(year + 1, month, day);
  if (!nextYear || daysBetween(now.dateKey, nextYear) > NEXT_YEAR_WINDOW_DAYS) return null;
  return nextYear;
}

/** "15일까지" / "the 15th": this month's if still ahead, else next month's. */
export function upcomingDayOfMonth(now: LocalNow, day: number): string | null {
  const { year, month } = parts(now.dateKey);
  const thisMonth = validDateKey(year, month, day);
  if (thisMonth && thisMonth >= now.dateKey) return thisMonth;
  const next = new Date(Date.UTC(year, month, 1));
  return validDateKey(next.getUTCFullYear(), next.getUTCMonth() + 1, day);
}

/** Day `day` of the month `monthsAhead` out ("다음 달 15일"); null if gone or nonexistent. */
export function dayInMonth(now: LocalNow, monthsAhead: number, day: number): string | null {
  const { year, month } = parts(now.dateKey);
  const first = new Date(Date.UTC(year, month - 1 + monthsAhead, 1));
  const key = validDateKey(first.getUTCFullYear(), first.getUTCMonth() + 1, day);
  return key && key >= now.dateKey ? key : null;
}
