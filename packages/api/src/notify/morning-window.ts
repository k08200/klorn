/**
 * When a once-a-day reminder may go out under NOTIFY_WAIT_DIGEST (NT0, decided
 * 2026-11-17): the user-local morning, never inside quiet hours, and —
 * when quiet hours cover the morning — once they end, not never.
 *
 * The reply-wait reminder (#1803) and the overdue-task and deadline reminders
 * (agentcore/proactive-actions.ts) share it, so none of them rings on the
 * first tick after local midnight any more. Flag off, those reminders keep
 * their old timing; the caller decides.
 */

import { prisma } from "../db.js";
import { localDateKey, localMinuteOfDay } from "../time-zone.js";
import { isWithinQuietHours, lastEndedQuietWindow } from "./quiet-hours.js";

const MINUTES_PER_HOUR = 60;
const MS_PER_MINUTE = 60_000;
export const MORNING_WINDOW_START_HOUR = 9;
export const MORNING_WINDOW_END_HOUR = 12;
const WINDOW_START_MINUTE = MORNING_WINDOW_START_HOUR * MINUTES_PER_HOUR;
const WINDOW_END_MINUTE = MORNING_WINDOW_END_HOUR * MINUTES_PER_HOUR;
const WINDOW_MS = (WINDOW_END_MINUTE - WINDOW_START_MINUTE) * MS_PER_MINUTE;

/**
 * Whether a once-a-day reminder may go out now: never inside quiet hours;
 * inside [MORNING_WINDOW_START_HOUR, MORNING_WINDOW_END_HOUR) local; or, when
 * today's quiet hours ended after the window opened, for as long as the window
 * lasts after they ended — so quiet hours that cover the morning delay the
 * reminder, not drop it. Before the window opens nothing is read.
 */
export async function inMorningWindow(userId: string, tz: string, now: Date): Promise<boolean> {
  const minute = localMinuteOfDay(now, tz);
  if (minute < WINDOW_START_MINUTE) return false;
  const row = await prisma.automationConfig.findUnique({
    where: { userId },
    select: { quietHoursStart: true, quietHoursEnd: true },
  });
  const quiet = {
    quietHoursStart: row?.quietHoursStart ?? null,
    quietHoursEnd: row?.quietHoursEnd ?? null,
  };
  if (isWithinQuietHours(now, quiet, tz)) return false;
  if (minute < WINDOW_END_MINUTE) return true;
  const ended = lastEndedQuietWindow(now, quiet, tz);
  if (!ended || ended.endDateKey !== localDateKey(now, tz)) return false;
  return (
    localMinuteOfDay(ended.end, tz) > WINDOW_START_MINUTE &&
    now.getTime() - ended.end.getTime() < WINDOW_MS
  );
}
