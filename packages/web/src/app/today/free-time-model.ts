/**
 * Teams free-time (productization plan P12) — the pure rules behind Today's
 * "When is everyone free?": when it is offered, how the saved team's
 * availability is asked for, and how a slot reads. The read creates nothing:
 * scheduling stays in the assistant's own approval flow.
 */

import type { TeamFreeSlotWire } from "@klorn/contract";

/** How far ahead to look. The server refuses a window over 14 days. */
export const FREE_TIME_WINDOW_DAYS = 7;
/** The length of a common slot. */
export const FREE_TIME_DURATION_MINUTES = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const FALLBACK_TIME_ZONE = "UTC";

interface TeamModeFlag {
  teamMode?: boolean;
}

/** Offered only with team mode on and at least one saved team. */
export function freeTimeVisible(
  user: TeamModeFlag | null | undefined,
  teams: readonly unknown[],
): boolean {
  return user?.teamMode === true && teams.length > 0;
}

/**
 * Whose free time the slots are. With no member actually checked (every
 * calendar hidden), the slots are only the user's own and must not read as
 * "everyone is free".
 */
export function freeTimeScope(result: { checkedMembers: readonly string[] }): "team" | "self-only" {
  return result.checkedMembers.length > 0 ? "team" : "self-only";
}

/** GET /api/teams/:id/availability for the next FREE_TIME_WINDOW_DAYS days. */
export function availabilityPath(teamId: string, now: Date): string {
  const params = new URLSearchParams({
    window_start: now.toISOString(),
    window_end: new Date(now.getTime() + FREE_TIME_WINDOW_DAYS * DAY_MS).toISOString(),
    duration_minutes: String(FREE_TIME_DURATION_MINUTES),
  });
  return `/api/teams/${encodeURIComponent(teamId)}/availability?${params.toString()}`;
}

function formatters(locale: string, timeZone: string) {
  const day = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone,
  });
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });
  return { day, time };
}

/** "Thu, Oct 15 10:00–10:30" in the user's zone; empty for an unreadable slot. */
export function formatSlot(slot: TeamFreeSlotWire, locale: string, timeZone: string): string {
  const start = new Date(slot.startTime);
  const end = new Date(slot.endTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "";
  let f: ReturnType<typeof formatters>;
  try {
    f = formatters(locale, timeZone);
  } catch {
    // An unknown zone (RangeError): read it in UTC rather than show nothing.
    f = formatters(locale, FALLBACK_TIME_ZONE);
  }
  return `${f.day.format(start)} ${f.time.format(start)}–${f.time.format(end)}`;
}
