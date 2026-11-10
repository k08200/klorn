/**
 * Team mode v2 — alternative meeting slots.
 *
 * Pure: given the proposed slot plus the user's and the sender's busy
 * intervals, walk a half-hour grid FORWARD from the proposal and return the
 * first slots where BOTH are free, inside business hours (09:00–18:00) in
 * the user's time zone, weekdays only, never the proposed slot itself.
 * Anchored at the proposal — not the clock — so results are deterministic
 * and cacheable alongside the meeting context.
 */

export interface BusyInterval {
  /** ISO instants. */
  start: string;
  end: string;
}

export interface SuggestedSlot {
  startTime: string;
  endTime: string;
}

const STEP_MS = 30 * 60 * 1000;
const SEARCH_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 18;
const DEFAULT_DURATION_MS = 60 * 60 * 1000;
const MAX_SUGGESTIONS = 3;

export function suggestAlternativeSlots(input: {
  proposedStart: string;
  proposedEnd: string;
  myBusy: BusyInterval[];
  attendeeBusy: BusyInterval[];
  timeZone: string;
  maxSuggestions?: number;
}): SuggestedSlot[] {
  const proposedStart = Date.parse(input.proposedStart);
  const proposedEnd = Date.parse(input.proposedEnd);
  if (!Number.isFinite(proposedStart) || !Number.isFinite(proposedEnd)) return [];
  const duration = proposedEnd > proposedStart ? proposedEnd - proposedStart : DEFAULT_DURATION_MS;
  return findFreeSlots({
    windowStart: input.proposedStart,
    windowEnd: new Date(proposedStart + SEARCH_WINDOW_MS).toISOString(),
    durationMs: duration,
    busy: [...input.myBusy, ...input.attendeeBusy],
    timeZone: input.timeZone,
    maxSlots: input.maxSuggestions ?? MAX_SUGGESTIONS,
    skipStartIso: input.proposedStart,
  });
}

/**
 * Shared walk (team mode): the first slots inside [windowStart, windowEnd]
 * clear of every busy interval, half-hour grid, business hours 09:00–18:00
 * in the given time zone, weekdays only. `skipStartIso` (the alternative-slot
 * caller's original proposal) is never returned.
 */
export function findFreeSlots(input: {
  windowStart: string;
  windowEnd: string;
  durationMs: number;
  busy: BusyInterval[];
  timeZone: string;
  maxSlots?: number;
  skipStartIso?: string;
}): SuggestedSlot[] {
  const windowStart = Date.parse(input.windowStart);
  const windowEnd = Date.parse(input.windowEnd);
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) return [];
  const duration = input.durationMs > 0 ? input.durationMs : DEFAULT_DURATION_MS;
  const max = input.maxSlots ?? MAX_SUGGESTIONS;
  const skipStart = input.skipStartIso ? Date.parse(input.skipStartIso) : Number.NaN;

  const busy = input.busy
    .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);

  const fields = new Intl.DateTimeFormat("en-US", {
    timeZone: input.timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const localParts = (epoch: number): { weekday: string; minutes: number } => {
    const parts = fields.formatToParts(new Date(epoch));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    // "24" appears for midnight in some ICU versions — normalize.
    const hour = Number(get("hour")) % 24;
    return { weekday: get("weekday"), minutes: hour * 60 + Number(get("minute")) };
  };

  const out: SuggestedSlot[] = [];
  // First grid point at or after the window start.
  let cursor = Math.ceil(windowStart / STEP_MS) * STEP_MS;

  while (cursor <= windowEnd && out.length < max) {
    const start = cursor;
    const end = start + duration;
    cursor += STEP_MS;

    if (start === skipStart) continue; // never re-propose the proposal
    const local = localParts(start);
    if (local.weekday === "Sat" || local.weekday === "Sun") continue;
    if (local.minutes < BUSINESS_START_HOUR * 60) continue;
    const localEnd = localParts(end);
    // The slot must END inside the same business day (18:00 sharp allowed;
    // a slot crossing midnight shows an earlier end-minute and is rejected).
    if (localEnd.minutes > BUSINESS_END_HOUR * 60 || localEnd.minutes < local.minutes) continue;
    if (busy.some((b) => start < b.end && b.start < end)) continue;

    out.push({
      startTime: new Date(start).toISOString(),
      endTime: new Date(end).toISOString(),
    });
  }
  return out;
}
