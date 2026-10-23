/**
 * Which IANA zone the web app renders times in. Pure (no React) so it is
 * unit-tested from the api package; the hook lives in use-time-zone.ts.
 *
 * Order: a zone the user pinned in Settings (MANUAL) > the device zone >
 * the zone last synced to the account > UTC as the very last resort. With no
 * saved choice (AUTO, also an older API that sends no mode) the device zone
 * wins, so a traveller's times follow the laptop's clock.
 */

export type TimeZoneMode = "AUTO" | "MANUAL";

/** The Settings picker's "Automatic (device)" value. Never sent as a zone. */
export const AUTO_TIME_ZONE = "auto";

export const LAST_RESORT_TIME_ZONE = "UTC";

/** IANA names are `/`-joined segments, never a bare offset like "+09:00". */
const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

/**
 * Zone names an unconfigured or headless browser reports. Rendering in them is
 * honest (it is what the device says), but persisting one would overwrite a
 * real zone the account already holds, and the server schedules briefings and
 * quiet hours from it.
 */
const UTC_ALIASES = new Set(["UTC", "Etc/UTC", "Etc/GMT", "GMT", "Etc/Universal", "Etc/Zulu"]);

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !IANA_SHAPE.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The browser's zone, or null when it cannot be read. */
export function deviceTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

export interface TimeZoneInputs {
  /** From /api/auth/me; undefined on an older API reads as AUTO. */
  mode?: TimeZoneMode | null;
  /** The account's stored zone (AutomationConfig.timezone). */
  savedZone?: string | null;
  deviceZone?: string | null;
}

export function resolveDisplayTimeZone({ mode, savedZone, deviceZone }: TimeZoneInputs): string {
  if (mode === "MANUAL" && isValidTimeZone(savedZone)) return savedZone;
  if (isValidTimeZone(deviceZone)) return deviceZone;
  if (isValidTimeZone(savedZone)) return savedZone;
  return LAST_RESORT_TIME_ZONE;
}

/**
 * The zone to write to the account so server-side features (briefings, quiet
 * hours, meeting alerts, digests) use the device zone too — or null when
 * nothing should be written: a manual choice, an already-matching account, an
 * unreadable device zone, or a UTC alias (see UTC_ALIASES).
 */
export function autoSyncTarget({ mode, savedZone, deviceZone }: TimeZoneInputs): string | null {
  if (mode === "MANUAL") return null;
  if (!isValidTimeZone(deviceZone) || UTC_ALIASES.has(deviceZone)) return null;
  return deviceZone === savedZone ? null : deviceZone;
}

export interface TimeZonePreferenceBody {
  timezoneMode: TimeZoneMode;
  timezone?: string;
}

/**
 * PATCH /api/automations body for the Settings choice. Automatic carries the
 * device zone when it is worth persisting, so server-side schedules switch
 * immediately; null when a manual selection is not a real zone.
 */
export function timeZonePreferenceBody(
  selection: string,
  deviceZone: string | null,
): TimeZonePreferenceBody | null {
  if (selection === AUTO_TIME_ZONE) {
    return isValidTimeZone(deviceZone) && !UTC_ALIASES.has(deviceZone)
      ? { timezoneMode: "AUTO", timezone: deviceZone }
      : { timezoneMode: "AUTO" };
  }
  return isValidTimeZone(selection) ? { timezoneMode: "MANUAL", timezone: selection } : null;
}
