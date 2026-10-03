/**
 * The drive's providers (step D2 of docs/providers/unified-platform-plan.md).
 * A module of its own, with no import, so the kill switch and the seam can name
 * a provider without pulling in the database.
 */

/** Mirrors the Prisma `DriveProvider` enum (kept string-typed like CalendarProviderName). */
export type DriveProviderName = "KLORN" | "GOOGLE" | "ONEDRIVE" | "DEVICE";

/** Every provider, in the enum's order. */
export const DRIVE_PROVIDER_NAMES = [
  "KLORN",
  "GOOGLE",
  "ONEDRIVE",
  "DEVICE",
] as const satisfies readonly DriveProviderName[];
