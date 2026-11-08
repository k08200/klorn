/**
 * Calendar — the pure half: day keys in the user's zone, the week strip, the
 * agenda of one day across every connected calendar, the source legend,
 * conflicts, the current-time line, and the new-event draft. No React, no DOM
 * (model.test.ts pins it).
 */
import type { InboxPurpose } from "@klorn/contract";
import { isEntitlementRefusal } from "../../api/client";
import type { CalendarEventWire, EventDraftWire } from "../../api/wire";

/** "2026-10-16" — a calendar day in the user's zone. */
export type DayKey = string;

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDayKey(value: unknown): value is DayKey {
  if (typeof value !== "string") return false;
  const m = DAY_KEY.exec(value);
  if (!m) return false;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.toISOString().slice(0, 10) === value;
}

function parts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const v = (type: string) => Number(fmt.find((p) => p.type === type)?.value);
  return {
    year: v("year"),
    month: v("month"),
    day: v("day"),
    hour: v("hour"),
    minute: v("minute"),
    second: v("second"),
  };
}

export function dayKeyOf(date: Date, timeZone: string): DayKey {
  const p = parts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function keyToUtc(key: DayKey): number {
  const m = DAY_KEY.exec(key);
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function addDays(key: DayKey, days: number): DayKey {
  return new Date(keyToUtc(key) + days * 86_400_000).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(key: DayKey): number {
  return new Date(keyToUtc(key)).getUTCDay();
}

function offsetMs(date: Date, timeZone: string): number {
  const p = parts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant a wall-clock time on `key` happens in the zone ("09:30" → Date). */
export function zonedInstant(key: DayKey, hhmm: string, timeZone: string): Date {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const wall = keyToUtc(key) + (h * 60 + m) * 60_000;
  const first = wall - offsetMs(new Date(wall), timeZone);
  return new Date(wall - offsetMs(new Date(first), timeZone));
}

/** Local midnight of the day (DST-safe). */
export function dayStart(key: DayKey, timeZone: string): Date {
  return zonedInstant(key, "00:00", timeZone);
}

/** "HH:MM" of an instant in the zone. */
export function wallTime(date: Date, timeZone: string): string {
  const p = parts(date, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** Monday-first everywhere but English (Sunday-first), as the artboard's 월…일. */
export function weekStartsOn(intlTag: string): 0 | 1 {
  return intlTag.startsWith("en") ? 0 : 1;
}

/** The seven days of the week that holds `key`. */
export function weekOf(key: DayKey, firstDay: 0 | 1): DayKey[] {
  const back = (weekdayOf(key) - firstDay + 7) % 7;
  const start = addDays(key, -back);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** The instants the week's events are read for: [first day's midnight, the day after the last). */
export function weekRange(days: readonly DayKey[], timeZone: string): { start: Date; end: Date } {
  const first = days[0] ?? dayKeyOf(new Date(), timeZone);
  const last = days[days.length - 1] ?? first;
  return { start: dayStart(first, timeZone), end: dayStart(addDays(last, 1), timeZone) };
}

function startOf(e: CalendarEventWire): number {
  return Date.parse(e.startTime);
}

function endOf(e: CalendarEventWire): number {
  return Date.parse(e.endTime);
}

function valid(e: CalendarEventWire): boolean {
  return Number.isFinite(startOf(e)) && Number.isFinite(endOf(e));
}

/**
 * The day's agenda: all-day events first, then timed ones by start. A timed
 * event belongs to the day it starts on; an all-day one to every day it covers.
 */
export function eventsOnDay(
  events: readonly CalendarEventWire[],
  key: DayKey,
  timeZone: string,
): CalendarEventWire[] {
  const from = dayStart(key, timeZone).getTime();
  const to = dayStart(addDays(key, 1), timeZone).getTime();
  return events
    .filter(valid)
    .filter((e) =>
      e.allDay
        ? startOf(e) < to && endOf(e) > from
        : dayKeyOf(new Date(e.startTime), timeZone) === key,
    )
    .sort(
      (a, b) =>
        Number(b.allDay) - Number(a.allDay) || startOf(a) - startOf(b) || endOf(a) - endOf(b),
    );
}

/** Which days of the week have anything on them (the strip's dots). */
export function busyDays(
  events: readonly CalendarEventWire[],
  days: readonly DayKey[],
  timeZone: string,
): Set<DayKey> {
  return new Set(days.filter((d) => eventsOnDay(events, d, timeZone).length > 0));
}

export function isPast(e: CalendarEventWire, now: Date): boolean {
  return endOf(e) <= now.getTime();
}

/**
 * Where the current-time line goes on today's agenda: before the first timed
 * event that has not started yet (after everything when the day is done).
 * -1 when the line does not belong on this day.
 */
export function nowLineIndex(
  dayEvents: readonly CalendarEventWire[],
  key: DayKey,
  now: Date,
  timeZone: string,
): number {
  if (dayKeyOf(now, timeZone) !== key) return -1;
  const at = now.getTime();
  const index = dayEvents.findIndex((e) => !e.allDay && startOf(e) > at);
  return index === -1 ? dayEvents.length : index;
}

export interface Conflict {
  /** The event the other one overlaps. */
  with: CalendarEventWire;
}

/**
 * Overlapping timed events. The earlier one of each pair carries the conflict
 * (the artboard's chip on the 14:00 meeting, naming the 14:30 1:1); all-day
 * events never conflict.
 */
export function conflictsOf(dayEvents: readonly CalendarEventWire[]): Map<string, Conflict> {
  const timed = dayEvents.filter((e) => !e.allDay && valid(e));
  const out = new Map<string, Conflict>();
  for (let i = 0; i < timed.length; i++) {
    const a = timed[i];
    if (!a) continue;
    for (let j = i + 1; j < timed.length; j++) {
      const b = timed[j];
      if (!b) continue;
      if (startOf(b) >= endOf(a)) continue;
      if (startOf(a) < endOf(b) && !out.has(a.id)) out.set(a.id, { with: b });
    }
  }
  return out;
}

/** The first timed event that overlaps `id` on its day, either way round (the detail's note). */
export function overlapOf(
  dayEvents: readonly CalendarEventWire[],
  id: string,
): CalendarEventWire | null {
  const self = dayEvents.find((e) => e.id === id);
  if (!self || self.allDay || !valid(self)) return null;
  return (
    dayEvents.find(
      (e) =>
        e.id !== id &&
        !e.allDay &&
        valid(e) &&
        startOf(e) < endOf(self) &&
        startOf(self) < endOf(e),
    ) ?? null
  );
}

// ── Sources ─────────────────────────────────────────────────────────────────

export interface CalendarSource {
  key: string;
  provider: string;
  /** null = the primary calendar (labelled from its account's purpose). */
  label: string | null;
  purpose: InboxPurpose | null;
}

/** The connected calendar an event came from: a linked account, else the primary one. */
export function sourceOf(
  e: CalendarEventWire,
  primaryPurpose: InboxPurpose | null,
): CalendarSource {
  const provider = e.provider ?? "GOOGLE";
  if (e.sourceAccountId) {
    return { key: e.sourceAccountId, provider, label: e.sourceLabel ?? null, purpose: null };
  }
  if (provider === "LOCAL" || provider === "GOOGLE") {
    return { key: "primary", provider: "GOOGLE", label: null, purpose: primaryPurpose };
  }
  return { key: `primary:${provider}`, provider, label: e.sourceLabel ?? null, purpose: null };
}

/** The legend: each source once, in the order its first event appears. */
export function legendOf(
  events: readonly CalendarEventWire[],
  primaryPurpose: InboxPurpose | null,
): CalendarSource[] {
  const seen = new Map<string, CalendarSource>();
  for (const e of [...events].sort((a, b) => startOf(a) - startOf(b))) {
    const source = sourceOf(e, primaryPurpose);
    if (!seen.has(source.key)) seen.set(source.key, source);
  }
  return [...seen.values()];
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** "9:30" / "14:00" (24 h outside English), "9:30 AM" in English — the agenda's time column. */
export function agendaTime(date: Date, intlTag: string, timeZone: string): string {
  if (intlTag.startsWith("en")) {
    return new Intl.DateTimeFormat(intlTag, {
      hour: "numeric",
      minute: "2-digit",
      hourCycle: "h12",
      timeZone,
    }).format(date);
  }
  // Intl pads the hour in most 24-hour locales; the artboard reads "9:30".
  return wallTime(date, timeZone).replace(/^0(?=\d:)/, "");
}

/** "10월" / "October" and "2026" for the large title. */
export function monthTitle(key: DayKey, intlTag: string): { month: string; year: string } {
  const date = new Date(keyToUtc(key));
  return {
    month: new Intl.DateTimeFormat(intlTag, { month: "long", timeZone: "UTC" }).format(date),
    year: new Intl.DateTimeFormat(intlTag, { year: "numeric", timeZone: "UTC" })
      .format(date)
      .replace(/[^\d]/g, ""),
  };
}

/** "목" / "Thu" — the strip's weekday initial. */
export function weekdayShort(key: DayKey, intlTag: string): string {
  return new Intl.DateTimeFormat(intlTag, { weekday: "short", timeZone: "UTC" })
    .format(new Date(keyToUtc(key)))
    .replace(/요일$/, "");
}

export function weekdayLong(key: DayKey, intlTag: string): string {
  return new Intl.DateTimeFormat(intlTag, { weekday: "long", timeZone: "UTC" }).format(
    new Date(keyToUtc(key)),
  );
}

/** "10월 16일 목요일" — a day in words. */
export function dayLong(key: DayKey, intlTag: string): string {
  return new Intl.DateTimeFormat(intlTag, {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "UTC",
  }).format(new Date(keyToUtc(key)));
}

export function dayOfMonth(key: DayKey): number {
  return Number(key.slice(8, 10));
}

/** "10월 21일 (수)" — the day part of a slot. */
export function slotDay(iso: string, intlTag: string, timeZone: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return new Intl.DateTimeFormat(intlTag, {
    weekday: "short",
    month: "long",
    day: "numeric",
    timeZone,
  }).format(date);
}

/** "화 10월 21일 · 10:00–11:00" — a proposed slot or a draft's time. */
export function slotLabel(
  startIso: string,
  endIso: string,
  intlTag: string,
  timeZone: string,
): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return startIso;
  const day = slotDay(startIso, intlTag, timeZone);
  return `${day} · ${agendaTime(start, intlTag, timeZone)}–${agendaTime(end, intlTag, timeZone)}`;
}

// ── New event ───────────────────────────────────────────────────────────────

export interface EventForm {
  title: string;
  day: DayKey;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  /** Comma- or space-separated addresses; saving invites them. */
  attendees: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseAttendees(raw: string): { valid: string[]; invalid: string[] } {
  const items = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(items)];
  return {
    valid: unique.filter((a) => EMAIL.test(a)).slice(0, 20),
    invalid: unique.filter((a) => !EMAIL.test(a)),
  };
}

export type FormProblem = "title" | "time" | "attendees" | null;

/** The draft the confirm card shows and POST /api/calendar receives, or what is wrong. */
export function draftFromForm(
  form: EventForm,
  timeZone: string,
): { draft: EventDraftWire; problem: null } | { draft: null; problem: Exclude<FormProblem, null> } {
  const title = form.title.trim();
  if (!title || title.length > 300) return { draft: null, problem: "title" };
  const people = parseAttendees(form.attendees);
  if (people.invalid.length > 0) return { draft: null, problem: "attendees" };
  let start: Date;
  let end: Date;
  if (form.allDay) {
    start = dayStart(form.day, timeZone);
    end = dayStart(addDays(form.day, 1), timeZone);
  } else {
    if (!/^\d{2}:\d{2}$/.test(form.start) || !/^\d{2}:\d{2}$/.test(form.end)) {
      return { draft: null, problem: "time" };
    }
    start = zonedInstant(form.day, form.start, timeZone);
    end = zonedInstant(form.day, form.end, timeZone);
    if (end.getTime() <= start.getTime()) return { draft: null, problem: "time" };
  }
  return {
    problem: null,
    draft: {
      title,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      ...(form.location.trim() ? { location: form.location.trim() } : {}),
      ...(people.valid.length ? { attendees: people.valid } : {}),
      ...(form.allDay ? { allDay: true } : {}),
    },
  };
}

/** A sensible start for a new event on `day`: the next whole hour today, else 10:00. */
export function defaultFormFor(day: DayKey, now: Date, timeZone: string): EventForm {
  let start = "10:00";
  if (dayKeyOf(now, timeZone) === day) {
    const hour = Number(wallTime(now, timeZone).slice(0, 2)) + 1;
    if (hour <= 22) start = `${String(hour).padStart(2, "0")}:00`;
  }
  // The start is at most 22:00, so the hour after it is still the same day.
  const endHour = Number(start.slice(0, 2)) + 1;
  return {
    title: "",
    day,
    start,
    end: `${String(endHour).padStart(2, "0")}:00`,
    allDay: false,
    location: "",
    attendees: "",
  };
}

/** A draft (from the assistant, a free slot or the parser) back into the form. */
export function formFromDraft(
  draft: Partial<EventDraftWire>,
  fallback: EventForm,
  timeZone: string,
): EventForm {
  const start = draft.startTime ? new Date(draft.startTime) : null;
  const end = draft.endTime ? new Date(draft.endTime) : null;
  const okStart = start && Number.isFinite(start.getTime()) ? start : null;
  const okEnd = end && Number.isFinite(end.getTime()) ? end : null;
  return {
    ...fallback,
    title: draft.title ?? fallback.title,
    day: okStart ? dayKeyOf(okStart, timeZone) : fallback.day,
    start: okStart ? wallTime(okStart, timeZone) : fallback.start,
    end: okEnd ? wallTime(okEnd, timeZone) : fallback.end,
    location: draft.location ?? fallback.location,
    attendees: draft.attendees?.join(", ") ?? fallback.attendees,
    allDay: draft.allDay ?? fallback.allDay,
  };
}

/**
 * What a failed event save shows: the plans prompt for the plan refusal
 * (403 ENTITLEMENT_REQUIRED) only; any other failure is the plain error.
 */
export function saveStateAfterFailure(err: unknown): "paywalled" | "error" {
  return isEntitlementRefusal(err) ? "paywalled" : "error";
}
