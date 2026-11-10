/**
 * The device calendar sources of a user (step C6 of
 * docs/providers/unified-platform-plan.md): one LinkedCalendarAccount with provider
 * DEVICE per calendar a desktop app uploads. A source exists only because the user
 * turned that calendar on on the device (decision P4): its first snapshot creates
 * it (device-ingest.ts), and turning it off removes it with every row and attention
 * item it brought (`removeDeviceSource`). Every query is scoped to the user and to
 * provider DEVICE, so this surface can never see or remove another provider's
 * account.
 */

import { prisma } from "../../db.js";
import { captureError } from "../../sentry.js";
import { unlinkCalendarAccount } from "../linked-calendar-unlink.js";
import { deviceKeyOfEmail, deviceSourceEmail, isDeviceSourceKey } from "./device-source-key.js";

export { deviceSourceEmail } from "./device-source-key.js";

/** New sources a user may have (every device together); a known one is always taken. */
export const DEVICE_MAX_SOURCES_PER_USER = 50;
/**
 * Rows one source may hold after a snapshot. A window holds at most 500 events and
 * rows older than the retention are pruned, so a real calendar stays far below it;
 * a device that floods distinct tiny windows stops here (409, nothing changed).
 */
export const DEVICE_MAX_ROWS_PER_SOURCE = 1_000;
/** Device rows one user may hold across every source and device. */
export const DEVICE_MAX_ROWS_PER_USER = 10_000;
/**
 * A source no snapshot refreshed for this long is removed with its rows: its Mac
 * was wiped, uninstalled or left offline (P4: nothing stays that no device still
 * shows). A running Mac re-sends an unchanged calendar every 6 hours.
 */
export const DEVICE_SOURCE_EXPIRY_DAYS = 14;
/** Sources expired per sweep; the next hourly sweep takes the rest. */
const EXPIRY_BATCH = 200;
const DAY_MS = 86_400_000;

export interface DeviceSourceSummary {
  /** The device's key for the calendar (never the raw EventKit identifier). */
  readonly key: string;
  /** The calendar's title on the device. */
  readonly title: string | null;
  /** When the last snapshot of it was stored. */
  readonly uploadedAt: Date;
}

/** The user's device calendars, oldest first: what a settings screen lists. */
export async function listDeviceSources(userId: string): Promise<DeviceSourceSummary[]> {
  const accounts = await prisma.linkedCalendarAccount.findMany({
    where: { userId, provider: "DEVICE" },
    select: { email: true, displayName: true, updatedAt: true },
    orderBy: { createdAt: "asc" },
  });
  return accounts.flatMap((account) => {
    const key = deviceKeyOfEmail(account.email);
    return key === null ? [] : [{ key, title: account.displayName, uploadedAt: account.updatedAt }];
  });
}

/**
 * Remove one device calendar of the user, with its rows and their attention items,
 * in one transaction (the shared unlink, scoped to provider DEVICE). False, having
 * removed nothing, when the user has no such calendar.
 */
export async function removeDeviceSource(userId: string, key: string): Promise<boolean> {
  if (!isDeviceSourceKey(key)) return false;
  const account = await prisma.linkedCalendarAccount.findFirst({
    where: { userId, provider: "DEVICE", email: deviceSourceEmail(key) },
    select: { id: true },
  });
  if (!account) return false;
  return unlinkCalendarAccount(userId, account.id, "DEVICE");
}

/**
 * Remove every DEVICE source (of any user) that no snapshot refreshed for
 * DEVICE_SOURCE_EXPIRY_DAYS, each with its rows and their attention items, through
 * the same unlink as a switch-off. Run hourly by the scheduler. Returns how many
 * were removed.
 */
export async function expireStaleDeviceSources(now: Date): Promise<number> {
  const stale = await prisma.linkedCalendarAccount.findMany({
    where: {
      provider: "DEVICE",
      updatedAt: { lt: new Date(now.getTime() - DEVICE_SOURCE_EXPIRY_DAYS * DAY_MS) },
    },
    select: { id: true, userId: true },
    orderBy: { updatedAt: "asc" },
    take: EXPIRY_BATCH,
  });
  let removed = 0;
  for (const source of stale) {
    // Each source on its own: one that fails (a lock, a lost connection) is reported
    // and left for the next sweep, and never blocks the ones after it.
    try {
      if (await unlinkCalendarAccount(source.userId, source.id, "DEVICE")) removed += 1;
    } catch (err) {
      console.warn(
        `[CALENDAR] device source expiry failed for ${source.userId}:${source.id}:`,
        err,
      );
      captureError(err, {
        tags: { scope: "calendar.device.source_expiry" },
        extra: { userId: source.userId, linkedAccountId: source.id },
      });
    }
  }
  return removed;
}
