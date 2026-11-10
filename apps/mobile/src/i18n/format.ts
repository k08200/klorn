/** Locale-aware date/time formatting for the app chrome. Pure. */

/** "10월 16일 목요일" / "Thursday, October 16". */
export function formatLongDate(date: Date, intlTag: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(intlTag, {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone,
  }).format(date);
}

/** 24-hour "11:00" in Korean/Japanese/Chinese/European locales, "11:00 AM" in English. */
export function formatClock(date: Date, intlTag: string, timeZone?: string): string {
  const english = intlTag.startsWith("en");
  return new Intl.DateTimeFormat(intlTag, {
    hour: english ? "numeric" : "2-digit",
    minute: "2-digit",
    hourCycle: english ? "h12" : "h23",
    timeZone,
  }).format(date);
}

/** "32분 후" / "in 32 min" — minutes until `target`, hours past 90 minutes. */
export function formatRelativeFromNow(target: Date, now: Date, intlTag: string): string {
  const minutes = Math.round((target.getTime() - now.getTime()) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(intlTag, { numeric: "always", style: "short" });
  if (Math.abs(minutes) < 90) return rtf.format(minutes, "minute");
  return rtf.format(Math.round(minutes / 60), "hour");
}
