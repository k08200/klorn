/**
 * Quiet hours — the user's do-not-disturb window for browser push.
 *
 * Pure time-window math; no DB access. push.ts is the single choke point
 * that enforces this for every push call site (briefing, reminder-scheduler,
 * automation-scheduler, proactive-actions, background, autonomous-agent).
 * Suppression only blocks the phone ding — callers create the Notification
 * row upstream, so the event stays visible in the bell UI, and push.ts logs
 * a SKIPPED PushDeliveryLog row with skipReason "quiet_hours". Held PUSH mail
 * rings once after the window ends (quiet-hours-summary.ts, which reads the
 * window from lastEndedQuietWindow below).
 *
 * Window semantics: start minute inclusive, end minute exclusive. Windows
 * may cross midnight (e.g. 22:00–08:00). Evaluated in the user's timezone
 * (AutomationConfig.timezone) via the shared time-zone helpers.
 */

import {
  addDaysToDateKey,
  localDateKey,
  localDateTimeToUtc,
  localMinuteOfDay,
  normalizeTimeZone,
} from "../time-zone.js";

const MINUTES_PER_HOUR = 60;
const MAX_HOUR = 23;
const MAX_MINUTE = 59;
const TIME_OF_DAY_PATTERN = /^(\d{1,2}):(\d{2})$/;

export interface QuietHoursConfig {
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
}

/**
 * True when `now` falls inside the configured quiet window in the user's
 * timezone. Unset or malformed config means quiet hours are disabled.
 */
export function isWithinQuietHours(now: Date, config: QuietHoursConfig, timezone: string): boolean {
  const startMinute = parseTimeOfDay(config.quietHoursStart);
  const endMinute = parseTimeOfDay(config.quietHoursEnd);
  if (startMinute === null || endMinute === null) return false; // disabled / malformed
  if (startMinute === endMinute) return false; // zero-length window

  const nowMinute = localMinuteOfDay(now, normalizeTimeZone(timezone));
  if (startMinute < endMinute) {
    // Same-day window, e.g. 13:00–17:00
    return nowMinute >= startMinute && nowMinute < endMinute;
  }
  // Crosses midnight, e.g. 22:00–08:00
  return nowMinute >= startMinute || nowMinute < endMinute;
}

/** One quiet window as real instants: [start, end), and the local date it ended on. */
export interface QuietWindow {
  start: Date;
  end: Date;
  /** `YYYY-MM-DD` in the user's timezone: names the window (one per night). */
  endDateKey: string;
}

/**
 * The most recent quiet window that has ENDED by `now`, in the user's
 * timezone; null when quiet hours are off, malformed or zero-length, or while
 * `now` is still inside one. A window that crosses midnight started the
 * evening before the date it ended on. Edges are wall-clock times converted
 * with the zone's offset at that instant, so a DST change inside the window
 * moves neither edge.
 */
export function lastEndedQuietWindow(
  now: Date,
  config: QuietHoursConfig,
  timezone: string,
): QuietWindow | null {
  const startMinute = parseTimeOfDay(config.quietHoursStart);
  const endMinute = parseTimeOfDay(config.quietHoursEnd);
  if (startMinute === null || endMinute === null || startMinute === endMinute) return null;
  const tz = normalizeTimeZone(timezone);
  if (isWithinQuietHours(now, config, tz)) return null;

  const today = localDateKey(now, tz);
  const endDateKey = localMinuteOfDay(now, tz) >= endMinute ? today : addDaysToDateKey(today, -1);
  const startDateKey = startMinute < endMinute ? endDateKey : addDaysToDateKey(endDateKey, -1);
  return {
    start: localDateTimeToUtc(startDateKey, formatTimeOfDay(startMinute), tz),
    end: localDateTimeToUtc(endDateKey, formatTimeOfDay(endMinute), tz),
    endDateKey,
  };
}

function formatTimeOfDay(minuteOfDay: number): string {
  const hours = Math.floor(minuteOfDay / MINUTES_PER_HOUR);
  const minutes = minuteOfDay % MINUTES_PER_HOUR;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Parse "HH:MM" into minutes-of-day; null for unset or malformed values. */
function parseTimeOfDay(value: string | null): number | null {
  if (!value) return null;
  const match = TIME_OF_DAY_PATTERN.exec(value.trim());
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (hours > MAX_HOUR || minutes > MAX_MINUTE) return null;
  return hours * MINUTES_PER_HOUR + minutes;
}
