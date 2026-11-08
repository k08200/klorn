/**
 * Month-calendar types and timezone-aware date helpers, shared by the
 * desktop month grid (app/calendar/page.tsx) and the compact touch month
 * (compact-month.tsx).
 */

export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  startTime: string;
  endTime: string;
  location: string | null;
  meetingLink: string | null;
  allDay: boolean;
  /** Present (true) on a linked calendar's event: a read-only mirror (step C7). */
  readOnly?: boolean;
  /** The linked account's email, on a linked event only. */
  sourceLabel?: string;
}

/** Short weekday names Sun..Sat in `locale`. 2026-01-04 (UTC noon) is a Sunday. */
export function weekdayNames(locale: string): string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  return Array.from({ length: 7 }, (_, i) => format.format(new Date(Date.UTC(2026, 0, 4 + i, 12))));
}

// 24-hour format keeps "13:00" unambiguous (the AM/PM split has been a
// dogfood pain point — "04:00 AM" in the calendar looked like 4 in the
// morning when the underlying event was 13:00 KST). The timezone arg is
// the user's stored IANA zone, NOT the browser default.
export function formatTime(d: Date, timeZone: string, locale: string): string {
  return d.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  });
}

// Day grouping must also respect the user's timezone — otherwise an event
// at 23:30 KST stored as 14:30 UTC ends up grouped under the wrong local
// day (the browser would call it "today" while the user calls it "tomorrow").
export function dayKeyForInZone(d: Date, timeZone: string): string {
  // en-CA returns YYYY-MM-DD, which is exactly the key shape we want and is
  // stable across locales.
  return d.toLocaleDateString("en-CA", { timeZone });
}

// ─── Month grid helpers ──────────────────────────────────────────────────
//
// All date math respects the user's IANA timezone so cell boundaries match
// what the user calls "Monday" — not what the browser calls "Monday" based
// on its locale guess.

export interface MonthCell {
  /** YYYY-MM-DD in the user's timezone — used as map key for events. */
  key: string;
  /** 1..31 — day number to display. */
  dayNumber: number;
  /** 0=Jan..11=Dec — index of the month this cell belongs to. */
  monthIndex: number;
}

/** Pinned first-of-month at 00:00 in the given timezone. */
export function firstOfMonth(d: Date, timeZone: string): Date {
  // Use ISO date-parts in the user's timezone, then construct a UTC moment
  // that represents 00:00 of that local day. This is the only safe way to
  // round-trip "month start" without lying about offsets.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  // Construct YYYY-MM-01 at noon UTC — noon avoids DST edges that 00:00
  // can land on for some zones.
  return new Date(Date.UTC(year, month - 1, 1, 12, 0, 0));
}

/** Add N months (can be negative). Day pinned to 1. */
export function addMonths(d: Date, n: number, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(d);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const totalMonths = (year - 1970) * 12 + (month - 1) + n;
  const newYear = 1970 + Math.floor(totalMonths / 12);
  const newMonth = totalMonths - (newYear - 1970) * 12;
  return new Date(Date.UTC(newYear, newMonth, 1, 12, 0, 0));
}

/** Month index 0..11 in the given timezone for a date. */
export function monthIndexInZone(d: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    month: "2-digit",
  }).formatToParts(d);
  return Number(parts.find((p) => p.type === "month")?.value) - 1;
}

/** Sunday-first weekday index 0..6 in the given timezone for a date. */
export function weekdayInZone(d: Date, timeZone: string): number {
  // Resolve the calendar date in the user's zone, then read its weekday from
  // the UTC clock — no locale week names to translate (and no hardcoded
  // English abbreviations).
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

/** Build the 42-cell month grid (6 rows × 7 days) including leading/trailing
 * padding from the adjacent months — same behavior as Google Calendar. */
export function buildMonthCells(viewMonth: Date, timeZone: string): MonthCell[] {
  const monthStart = firstOfMonth(viewMonth, timeZone);
  const firstWeekday = weekdayInZone(monthStart, timeZone);
  // Anchor 12:00 UTC keeps DST jumps from skipping a day.
  const anchor = new Date(monthStart.getTime() - firstWeekday * 86400000);
  const cells: MonthCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(anchor.getTime() + i * 86400000);
    cells.push({
      key: dayKeyForInZone(d, timeZone),
      dayNumber: Number(new Intl.DateTimeFormat("en-CA", { timeZone, day: "2-digit" }).format(d)),
      monthIndex: monthIndexInZone(d, timeZone),
    });
  }
  return cells;
}

/** Range to fetch — first and last cell of the visible grid, expanded by
 * one day on each side so events overlapping the boundary aren't dropped. */
export function monthGridRange(viewMonth: Date, timeZone: string): { start: Date; end: Date } {
  const cells = buildMonthCells(viewMonth, timeZone);
  // Cells are sorted; take ends and pad by 24h.
  const firstKey = cells[0].key;
  const lastKey = cells[cells.length - 1].key;
  // `key` is YYYY-MM-DD in user TZ — parse back via Date for the API range.
  // Use noon UTC so the range covers a full local day on both ends regardless
  // of DST.
  const start = new Date(`${firstKey}T00:00:00Z`);
  const end = new Date(`${lastKey}T23:59:59Z`);
  start.setUTCHours(start.getUTCHours() - 12);
  end.setUTCHours(end.getUTCHours() + 12);
  // Suppress no-unused-vars on timeZone — used by the helpers above; keeping
  // it in the signature so future callers don't need to import zone state.
  void timeZone;
  return { start, end };
}
