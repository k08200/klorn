/**
 * Bounded recognisers for the timestamp and date shapes in KakaoTalk exports
 * (docs/providers/kakaotalk-import.md §2). Hand-written scanners, no regex:
 * each reads a fixed-length prefix of one already length-capped line, moving a
 * cursor forward only, so a hostile line costs at most a few dozen steps here.
 */

/** A calendar date, as written in the export (no zone). */
export interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** A clock time on the 24-hour clock. */
export interface LocalTime {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** A timestamped line head: the wall clock, and the line after the time. */
export interface LineHead {
  readonly localMs: number;
  readonly rest: string;
}

const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
const MAX_MONTH_NAME = 10;
const HOURS_PER_HALF_DAY = 12;
const SEPARATOR_DASHES = "---";

const MONTHS: ReadonlyMap<string, number> = new Map([
  ["jan", 1],
  ["january", 1],
  ["feb", 2],
  ["february", 2],
  ["mar", 3],
  ["march", 3],
  ["apr", 4],
  ["april", 4],
  ["may", 5],
  ["jun", 6],
  ["june", 6],
  ["jul", 7],
  ["july", 7],
  ["aug", 8],
  ["august", 8],
  ["sep", 9],
  ["sept", 9],
  ["september", 9],
  ["oct", 10],
  ["october", 10],
  ["nov", 11],
  ["november", 11],
  ["dec", 12],
  ["december", 12],
]);

const WEEKDAYS = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

type Meridiem = "am" | "pm" | null;

/** A forward-only cursor over one line. */
export class Cursor {
  i = 0;
  constructor(readonly s: string) {}

  atEnd(): boolean {
    return this.i >= this.s.length;
  }

  peek(): string {
    return this.s[this.i] ?? "";
  }

  lit(token: string): boolean {
    if (!this.s.startsWith(token, this.i)) return false;
    this.i += token.length;
    return true;
  }

  /** Skip spaces; a line is capped, so this is bounded. */
  spaces(): void {
    while (this.s[this.i] === " ") this.i++;
  }

  /** 1..maxDigits ASCII digits, or null (cursor unchanged). */
  int(maxDigits: number): number | null {
    let value = 0;
    let digits = 0;
    while (digits < maxDigits) {
      const code = this.s.charCodeAt(this.i + digits);
      if (!(code >= 48 && code <= 57)) break;
      value = value * 10 + (code - 48);
      digits++;
    }
    if (digits === 0) return null;
    this.i += digits;
    return value;
  }

  /** Exactly `count` digits, or null. */
  fixed(count: number): number | null {
    const start = this.i;
    const value = this.int(count);
    if (value === null || this.i - start !== count) {
      this.i = start;
      return null;
    }
    return value;
  }

  /** Up to `max` ASCII letters, or "" (cursor unchanged when none). */
  letters(max: number): string {
    const start = this.i;
    while (this.i - start < max) {
      const code = this.s.charCodeAt(this.i);
      const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
      if (!letter) break;
      this.i++;
    }
    return this.s.slice(start, this.i);
  }

  rest(): string {
    return this.s.slice(this.i);
  }
}

export function validDate(year: number, month: number, day: number): boolean {
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1) return false;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= lastDay;
}

function hour24(hour: number, meridiem: Meridiem): number | null {
  if (meridiem === null) return hour <= 23 ? hour : null;
  if (hour < 1 || hour > HOURS_PER_HALF_DAY) return null;
  const base = hour % HOURS_PER_HALF_DAY;
  return meridiem === "pm" ? base + HOURS_PER_HALF_DAY : base;
}

function koreanMeridiem(cursor: Cursor): Meridiem {
  if (cursor.lit("오전")) return "am";
  if (cursor.lit("오후")) return "pm";
  return null;
}

function trailingMeridiem(cursor: Cursor): Meridiem {
  const start = cursor.i;
  if (!cursor.lit(" ")) return null;
  const word = cursor.letters(2).toLowerCase();
  if (word === "am") return "am";
  if (word === "pm") return "pm";
  cursor.i = start;
  return null;
}

/**
 * `오후 3:21`, `3:21 PM`, `15:21`, each with optional `:SS`. A meridiem on
 * both sides, or an hour the meridiem rules out, is not a time.
 */
export function readTime(cursor: Cursor): LocalTime | null {
  const before = koreanMeridiem(cursor);
  if (before !== null) cursor.spaces();
  const rawHour = cursor.int(2);
  if (rawHour === null || !cursor.lit(":")) return null;
  const minute = cursor.fixed(2);
  if (minute === null || minute > 59) return null;
  let second = 0;
  if (cursor.peek() === ":") {
    // `:SS`, or the `:` an iOS-style notice puts right after the time.
    const colon = cursor.i;
    cursor.i++;
    const value = cursor.fixed(2);
    if (value === null) cursor.i = colon;
    else if (value > 59) return null;
    else second = value;
  }
  const after = trailingMeridiem(cursor);
  if (before !== null && after !== null) return null;
  const hour = hour24(rawHour, before ?? after);
  return hour === null ? null : { hour, minute, second };
}

/** `2026. 11. 10.` */
export function readDottedDate(cursor: Cursor): LocalDate | null {
  const year = cursor.fixed(4);
  if (year === null || !cursor.lit(".")) return null;
  cursor.spaces();
  const month = cursor.int(2);
  if (month === null || !cursor.lit(".")) return null;
  cursor.spaces();
  const day = cursor.int(2);
  if (day === null || !cursor.lit(".")) return null;
  return validDate(year, month, day) ? { year, month, day } : null;
}

/** `2026년 11월 10일` */
export function readKoreanDate(cursor: Cursor): LocalDate | null {
  const year = cursor.fixed(4);
  if (year === null || !cursor.lit("년")) return null;
  cursor.spaces();
  const month = cursor.int(2);
  if (month === null || !cursor.lit("월")) return null;
  cursor.spaces();
  const day = cursor.int(2);
  if (day === null || !cursor.lit("일")) return null;
  return validDate(year, month, day) ? { year, month, day } : null;
}

/** `November 10, 2026` / `Nov 10, 2026` / `Nov. 10, 2026` */
export function readEnglishDate(cursor: Cursor): LocalDate | null {
  const month = MONTHS.get(cursor.letters(MAX_MONTH_NAME).toLowerCase());
  if (month === undefined) return null;
  cursor.lit(".");
  if (!cursor.lit(" ")) return null;
  const day = cursor.int(2);
  if (day === null || !cursor.lit(",")) return null;
  cursor.spaces();
  const year = cursor.fixed(4);
  if (year === null) return null;
  return validDate(year, month, day) ? { year, month, day } : null;
}

export function wallClockMs(date: LocalDate, time: LocalTime): number {
  return Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute, time.second);
}

/**
 * After a timestamp, a head is followed by `,` (a message or a notice), `:`
 * (an iOS-style notice) or nothing (a date line). Anything else means the
 * line only happens to start like a timestamp.
 */
function headAfterTime(cursor: Cursor, date: LocalDate, time: LocalTime): LineHead | null {
  const next = cursor.peek();
  if (next !== "" && next !== "," && next !== ":") return null;
  return { localMs: wallClockMs(date, time), rest: cursor.rest() };
}

/** `2026. 11. 10. 오후 3:21` + rest */
export function dottedHead(line: string): LineHead | null {
  const cursor = new Cursor(line);
  const date = readDottedDate(cursor);
  if (date === null || !cursor.lit(" ")) return null;
  cursor.spaces();
  const time = readTime(cursor);
  return time === null ? null : headAfterTime(cursor, date, time);
}

/** `2026년 11월 10일 오후 3:21` + rest */
export function koreanDateHead(line: string): LineHead | null {
  const cursor = new Cursor(line);
  const date = readKoreanDate(cursor);
  if (date === null || !cursor.lit(" ")) return null;
  cursor.spaces();
  const time = readTime(cursor);
  return time === null ? null : headAfterTime(cursor, date, time);
}

/** `November 10, 2026 at 3:21 PM` / `Nov 10, 2026, 3:21 PM` + rest */
export function englishDateHead(line: string): LineHead | null {
  const cursor = new Cursor(line);
  const date = readEnglishDate(cursor);
  if (date === null) return null;
  if (!(cursor.lit(" at ") || cursor.lit(", ") || cursor.lit(" "))) return null;
  const time = readTime(cursor);
  return time === null ? null : headAfterTime(cursor, date, time);
}

function readWeekdayEnglishDate(cursor: Cursor): LocalDate | null {
  const weekday = cursor.letters(MAX_MONTH_NAME).toLowerCase();
  if (!WEEKDAYS.has(weekday) || !cursor.lit(",")) return null;
  cursor.spaces();
  return readEnglishDate(cursor);
}

/** `2026년 11월 10일 화요일` or `Tuesday, November 10, 2026`, alone on the line. */
function bareDate(text: string): LocalDate | null {
  const korean = new Cursor(text);
  const koreanDate = readKoreanDate(korean);
  if (koreanDate !== null) {
    korean.spaces();
    const tail = korean.rest().trim();
    return tail === "" || (tail.length <= 4 && tail.endsWith("요일")) ? koreanDate : null;
  }
  const english = new Cursor(text);
  const englishDate = readWeekdayEnglishDate(english);
  return englishDate !== null && english.rest().trim() === "" ? englishDate : null;
}

/**
 * A date separator line: `--------------- 2026년 11월 10일 화요일 ---------------`
 * (PC), or the bare date line mobile exports print between days.
 */
export function separatorDate(line: string): LocalDate | null {
  if (!line.startsWith(SEPARATOR_DASHES)) return bareDate(line);
  let start = 0;
  while (start < line.length && (line[start] === "-" || line[start] === " ")) start++;
  let end = line.length;
  while (end > start && (line[end - 1] === "-" || line[end - 1] === " ")) end--;
  return bareDate(line.slice(start, end));
}

/** `[speaker] [오후 3:21] text` — the PC/Mac .txt message head. */
export interface BracketHead {
  readonly speaker: string;
  readonly time: LocalTime;
  readonly text: string;
}

export function bracketHead(line: string, maxSpeakerChars: number): BracketHead | null {
  if (!line.startsWith("[")) return null;
  const close = line.slice(0, maxSpeakerChars + 4).indexOf("] [");
  if (close <= 1) return null;
  const cursor = new Cursor(line);
  cursor.i = close + 3;
  const time = readTime(cursor);
  if (time === null || !cursor.lit("]")) return null;
  cursor.lit(" ");
  return { speaker: line.slice(1, close), time, text: cursor.rest() };
}

/** `2026-11-10 09:05:12` (PC .csv), falling back to the dotted mobile shape. */
export function csvTimestamp(field: string): number | null {
  const cursor = new Cursor(field.trim());
  const year = cursor.fixed(4);
  if (year !== null && cursor.lit("-")) {
    const month = cursor.int(2);
    if (month === null || !cursor.lit("-")) return null;
    const day = cursor.int(2);
    if (day === null || !cursor.lit(" ") || !validDate(year, month, day)) return null;
    cursor.spaces();
    const time = readTime(cursor);
    return time !== null && cursor.atEnd() ? wallClockMs({ year, month, day }, time) : null;
  }
  const head = dottedHead(field.trim());
  return head !== null && head.rest === "" ? head.localMs : null;
}
