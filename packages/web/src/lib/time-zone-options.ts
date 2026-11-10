/**
 * Data behind the Settings time zone picker: the common zones (labelled via
 * i18n), the full Intl list below them, offset labels and search. Pure.
 */

import { isValidTimeZone } from "./time-zone";

export interface CommonTimeZone {
  zone: string;
  /** i18n key for "Korea — Seoul" style labels. */
  labelKey: string;
}

export const COMMON_TIME_ZONES: readonly CommonTimeZone[] = [
  { zone: "UTC", labelKey: "settings.tz.zone.utc" },
  { zone: "Pacific/Honolulu", labelKey: "settings.tz.zone.honolulu" },
  { zone: "America/Anchorage", labelKey: "settings.tz.zone.anchorage" },
  { zone: "America/Los_Angeles", labelKey: "settings.tz.zone.losAngeles" },
  { zone: "America/Denver", labelKey: "settings.tz.zone.denver" },
  { zone: "America/Chicago", labelKey: "settings.tz.zone.chicago" },
  { zone: "America/New_York", labelKey: "settings.tz.zone.newYork" },
  { zone: "America/Sao_Paulo", labelKey: "settings.tz.zone.saoPaulo" },
  { zone: "Europe/London", labelKey: "settings.tz.zone.london" },
  { zone: "Europe/Berlin", labelKey: "settings.tz.zone.berlin" },
  { zone: "Asia/Dubai", labelKey: "settings.tz.zone.dubai" },
  { zone: "Asia/Kolkata", labelKey: "settings.tz.zone.kolkata" },
  { zone: "Asia/Singapore", labelKey: "settings.tz.zone.singapore" },
  { zone: "Asia/Shanghai", labelKey: "settings.tz.zone.shanghai" },
  { zone: "Asia/Seoul", labelKey: "settings.tz.zone.seoul" },
  { zone: "Asia/Tokyo", labelKey: "settings.tz.zone.tokyo" },
  { zone: "Australia/Sydney", labelKey: "settings.tz.zone.sydney" },
  { zone: "Pacific/Auckland", labelKey: "settings.tz.zone.auckland" },
];

const MINUS_SIGN = "−";
const MS_PER_MINUTE = 60_000;

/** Minutes `zone` is ahead of UTC at `at` (negative west of Greenwich). */
function offsetMinutes(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wallAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  const atMinute = Math.floor(at.getTime() / MS_PER_MINUTE) * MS_PER_MINUTE;
  return Math.round((wallAsUtc - atMinute) / MS_PER_MINUTE);
}

/** "UTC+9", "UTC−7", "UTC+5:30" or "UTC" — the offset in force at `at`. */
export function utcOffsetLabel(zone: string, at: Date = new Date()): string {
  if (!isValidTimeZone(zone)) return "";
  const total = offsetMinutes(zone, at);
  if (total === 0) return "UTC";
  const sign = total < 0 ? MINUS_SIGN : "+";
  const abs = Math.abs(total);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `UTC${sign}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}

/** Every zone this browser knows, common ones guaranteed present, sorted. */
export function allTimeZones(): string[] {
  let supported: string[] = [];
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    supported = intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    supported = [];
  }
  const merged = new Set([...supported, ...COMMON_TIME_ZONES.map((entry) => entry.zone)]);
  return [...merged].filter(isValidTimeZone).sort();
}

export interface TimeZoneOption {
  zone: string;
  label: string;
}

function searchable(text: string): string {
  return text.toLowerCase().replace(/_/g, " ");
}

/** Options whose zone id or label contains `query` (case/underscore-insensitive). */
export function filterTimeZones<T extends TimeZoneOption>(
  options: readonly T[],
  query: string,
): T[] {
  const needle = searchable(query.trim());
  if (!needle) return [...options];
  return options.filter(
    (option) =>
      searchable(option.zone).includes(needle) || searchable(option.label).includes(needle),
  );
}

/** "America/Argentina/Buenos_Aires" → "America / Argentina / Buenos Aires". */
export function zoneDisplayName(zone: string): string {
  return zone.replace(/_/g, " ").replace(/\//g, " / ");
}
