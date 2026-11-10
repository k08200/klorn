/**
 * The identity of a device calendar source (step C6 of
 * docs/providers/unified-platform-plan.md). A desktop app names each calendar it
 * uploads by a key it derives on the device: the sha256 hex digest of the EventKit
 * calendar identifier and the device id. The raw identifier never leaves the
 * device, and the same calendar on two Macs is two sources.
 *
 * The source is a LinkedCalendarAccount with provider DEVICE whose `email` is
 * `device:<key>`, so the existing (userId, provider, email) unique is its upsert
 * key, and no real address (which has an `@` and no such prefix) can collide with
 * it under the legacy (userId, email) unique.
 */

/** A lowercase sha256 hex digest: exactly what the device sends, nothing else. */
const DEVICE_SOURCE_KEY_PATTERN = /^[a-f0-9]{64}$/;

/** The same rule as a JSON-schema pattern, for the route's params. */
export const DEVICE_SOURCE_KEY_SCHEMA_PATTERN = "^[a-f0-9]{64}$";

export const DEVICE_SOURCE_EMAIL_PREFIX = "device:";

export function isDeviceSourceKey(value: unknown): value is string {
  return typeof value === "string" && DEVICE_SOURCE_KEY_PATTERN.test(value);
}

/** The `email` of a device calendar's LinkedCalendarAccount. */
export function deviceSourceEmail(key: string): string {
  if (!isDeviceSourceKey(key)) throw new Error("deviceSourceEmail needs a device source key");
  return `${DEVICE_SOURCE_EMAIL_PREFIX}${key}`;
}

/** The key back from a stored `email`, or null for any other value. */
export function deviceKeyOfEmail(email: string): string | null {
  if (!email.startsWith(DEVICE_SOURCE_EMAIL_PREFIX)) return null;
  const key = email.slice(DEVICE_SOURCE_EMAIL_PREFIX.length);
  return isDeviceSourceKey(key) ? key : null;
}
