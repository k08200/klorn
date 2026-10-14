/**
 * The drive kill switch (step D2 of docs/providers/unified-platform-plan.md;
 * mirrors pim/calendar-scope.ts).
 *
 * A DriveFile row is visible only while DRIVE_ENABLED is on AND its provider's
 * connector flag is. Turning a flag off stops the connector, but rows already
 * written would keep showing, so every DriveFile reader puts `driveSourceScope()`
 * into its `where` (or checks `isDriveRowVisible` on a row it fetched by id):
 * the rows disappear at once, and come back with the flag.
 * drive-file-guard.test.ts fails for a reader that does neither.
 *
 * Unlike the calendar's switch this one fails closed. The calendar hides the
 * providers it knows to be off; the drive shows only the providers known to be
 * on, because it has no legacy rows that must stay visible. A provider nobody
 * registered is hidden. The Klorn drive (D3) is registered, behind its own flag
 * and OBJECT_STORAGE_ENABLED (`klornDriveLive`).
 *
 * The fragment uses only the top-level key `provider`. A caller that filters on
 * a provider of its own must not spread one over the other: combine them with
 * `AND: [driveSourceScope(), { provider }]`.
 */

import type { Prisma } from "@prisma/client";
import { driveEnabled, klornDriveEnabled, objectStorageEnabled } from "../config.js";
import { DRIVE_PROVIDER_NAMES, type DriveProviderName } from "./drive-providers.js";

/** A provider to "is its connector enabled?", read at request time. */
export type DriveProviderEnabledMap = Readonly<Partial<Record<DriveProviderName, () => boolean>>>;

/**
 * The Klorn drive (D3) holds its bytes in object storage, so it is live only
 * while KLORN_DRIVE_ENABLED and OBJECT_STORAGE_ENABLED are both on (and, like
 * every provider, DRIVE_ENABLED; `visibleDriveProviders` checks that one).
 */
export function klornDriveLive(): boolean {
  return klornDriveEnabled() && objectStorageEnabled();
}

/**
 * The registered sources. D3 registers KLORN; D5 adds GOOGLE and D6 ONEDRIVE,
 * each with one entry naming its own flag. Every reader, the by-id check, the
 * dispatcher and the tests pick it up. Exported so a connector's own tests can
 * pass a map of their own.
 */
export const DRIVE_PROVIDER_ENABLED: DriveProviderEnabledMap = { KLORN: klornDriveLive };

/** The providers whose rows a reader may return right now, in the enum's order. */
export function visibleDriveProviders(
  providerEnabled: DriveProviderEnabledMap = DRIVE_PROVIDER_ENABLED,
): DriveProviderName[] {
  if (!driveEnabled()) return [];
  // Own keys only, and exactly `true`: a missing, inherited or truthy-but-wrong
  // gate never opens the switch.
  return DRIVE_PROVIDER_NAMES.filter(
    (provider) =>
      Object.hasOwn(providerEnabled, provider) && providerEnabled[provider]?.() === true,
  );
}

/** A Prisma where-fragment that matches only the rows of the visible providers. */
export function driveSourceScope(
  providerEnabled: DriveProviderEnabledMap = DRIVE_PROVIDER_ENABLED,
): Prisma.DriveFileWhereInput {
  return { provider: { in: visibleDriveProviders(providerEnabled) } };
}

/** False for a row the scope above hides, for a row fetched by id. */
export function isDriveRowVisible(
  row: { provider: string },
  providerEnabled: DriveProviderEnabledMap = DRIVE_PROVIDER_ENABLED,
): boolean {
  return (visibleDriveProviders(providerEnabled) as string[]).includes(row.provider);
}

/**
 * The gate of the Klorn drive's write and download routes (routes/klorn-drive.ts):
 * open exactly while KLORN rows are visible, so a file can never be written where
 * it could not be listed, or listed where it could not be fetched.
 */
export function klornDriveRoutesEnabled(
  providerEnabled: DriveProviderEnabledMap = DRIVE_PROVIDER_ENABLED,
): boolean {
  return visibleDriveProviders(providerEnabled).includes("KLORN");
}
