/**
 * Mail reminders (productization plan P5b, MAIL_V2): the three quick choices a
 * list row and the reader offer, and when each one fires. Pure — pinned by
 * packages/api/src/__tests__/web-mail-v2-model.test.ts. The times are the
 * legacy reader's: four hours from now, or 09:00 local tomorrow / in a week.
 */

export type ReminderKey = "later-today" | "tomorrow" | "next-week";

export const REMINDER_KEYS: readonly ReminderKey[] = ["later-today", "tomorrow", "next-week"];

export const REMINDER_LABEL_KEYS: Record<ReminderKey, string> = {
  "later-today": "mailV2.list.remind.today",
  tomorrow: "mailV2.list.remind.tomorrow",
  "next-week": "mailV2.list.remind.nextWeek",
};

const LATER_TODAY_HOURS = 4;
const MORNING_HOUR = 9;
const DAYS_AHEAD: Record<Exclude<ReminderKey, "later-today">, number> = {
  tomorrow: 1,
  "next-week": 7,
};

/** When a reminder set at `now` fires, in the browser's own time zone. */
export function reminderDate(key: ReminderKey, now: Date): Date {
  const date = new Date(now.getTime());
  if (key === "later-today") {
    date.setHours(date.getHours() + LATER_TODAY_HOURS);
    return date;
  }
  date.setDate(date.getDate() + DAYS_AHEAD[key]);
  date.setHours(MORNING_HOUR, 0, 0, 0);
  return date;
}
