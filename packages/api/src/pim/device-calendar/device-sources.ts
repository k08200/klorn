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
import { unlinkCalendarAccount } from "../linked-calendar-unlink.js";
import { deviceKeyOfEmail, deviceSourceEmail, isDeviceSourceKey } from "./device-source-key.js";

export { deviceSourceEmail } from "./device-source-key.js";

/** New sources a user may have (every device together); a known one is always taken. */
export const DEVICE_MAX_SOURCES_PER_USER = 50;

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
