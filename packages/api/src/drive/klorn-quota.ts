/**
 * The Klorn drive's storage quota (step D3 of
 * docs/providers/unified-platform-plan.md; decision P3: the number is decided at
 * flip time, and the schema does not depend on it).
 *
 * Usage is computed, not stored: the sum of the recorded sizes of the user's
 * Klorn files (drive/klorn-drive-read.ts). The limit comes from the environment,
 * read per request, and the drive fails closed without one:
 *
 *   KLORN_DRIVE_QUOTA_BYTES unset or blank  → every upload refused, 503
 *                                            `quota-not-configured` (boot warns
 *                                            by name while the drive is live);
 *   a whole number of bytes                → that limit, for every user;
 *   anything else                          → uploads fail closed (503), and the
 *                                            log names the variable.
 *
 * One number for everyone is all P3 needs before the flip. A per-plan limit
 * replaces `klornDriveQuotaBytes` and nothing else: `assertWithinKlornQuota` is
 * the only place the limit is applied.
 *
 * It is checked before the PUT and again right before the row. Uploads that
 * reach the commit at the same moment can all pass, so the limit can be
 * overshot by the files committing at once: a soft limit, not an accounting one.
 */

import { klornDriveRoutesEnabled } from "./drive-scope.js";
import { klornUsageBytes } from "./klorn-drive-read.js";
import { KlornDriveError } from "./klorn-errors.js";

export const KLORN_DRIVE_QUOTA_ENV = "KLORN_DRIVE_QUOTA_BYTES";
const WHOLE_BYTES = /^\d{1,15}$/;

/** The configured limit in bytes. Throws when it is missing or not usable: no upload without one. */
export function klornDriveQuotaBytes(): number {
  const raw = (process.env[KLORN_DRIVE_QUOTA_ENV] ?? "").trim();
  if (raw === "") throw new KlornDriveError("quota-not-configured");
  if (!WHOLE_BYTES.test(raw)) {
    console.error(`[DRIVE] ${KLORN_DRIVE_QUOTA_ENV} is not a whole number of bytes`);
    throw new KlornDriveError("storage-unavailable", { retryable: false });
  }
  return Number(raw);
}

/**
 * The limit, or null while every upload is refused for want of a usable one:
 * what a client shows before it offers an upload (`GET /api/drive/limits`).
 */
export function klornDriveQuotaOrNull(): number | null {
  try {
    return klornDriveQuotaBytes();
  } catch (err) {
    if (err instanceof KlornDriveError) return null;
    throw err;
  }
}

/** Throws `quota-exceeded` when `incomingBytes` more would pass the user's limit. */
export async function assertWithinKlornQuota(
  userId: string,
  incomingBytes: number,
  limit: number = klornDriveQuotaBytes(),
): Promise<void> {
  const used = await klornUsageBytes(userId);
  if (used + incomingBytes > limit) throw new KlornDriveError("quota-exceeded");
}

/**
 * Boot check: while the Klorn drive is live and no quota is set, every upload is
 * refused; say so by the variable's name (never a value). The flags are read per
 * request, so a flip after boot is caught by the refusal itself, not here.
 */
export function warnIfKlornDriveQuotaMissing(): void {
  if (!klornDriveRoutesEnabled()) return;
  if ((process.env[KLORN_DRIVE_QUOTA_ENV] ?? "").trim() !== "") return;
  console.warn(
    `[DRIVE] the Klorn drive is on but ${KLORN_DRIVE_QUOTA_ENV} is not set: every upload is refused (quota-not-configured) until it is.`,
  );
}
