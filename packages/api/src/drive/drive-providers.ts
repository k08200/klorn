/**
 * The drive's providers (step D2 of docs/providers/unified-platform-plan.md).
 * A module of its own, with no import, so the kill switch and the seam can name
 * a provider without pulling in the database.
 */

/**
 * Mirrors the Prisma `DriveProvider` enum (kept string-typed like
 * CalendarProviderName; drive-rows.test.ts pins the two against each other).
 * There is no DEVICE: a device import (D7) lands in the Klorn drive as KLORN rows.
 */
export type DriveProviderName = "KLORN" | "GOOGLE" | "ONEDRIVE";

/** Every provider, in the enum's order. */
export const DRIVE_PROVIDER_NAMES = [
  "KLORN",
  "GOOGLE",
  "ONEDRIVE",
] as const satisfies readonly DriveProviderName[];

/** The one provider whose bytes Klorn holds (D1), and so the one it can change. */
export function isKlornDriveProvider(provider: DriveProviderName): boolean {
  return provider === "KLORN";
}

/**
 * Decision V4: Klorn lists, searches and summarises an external drive's files; it
 * never uploads to one or edits one. Not stored on the row: it follows from the
 * provider.
 */
export function isReadOnlyDriveProvider(provider: DriveProviderName): boolean {
  return !isKlornDriveProvider(provider);
}
