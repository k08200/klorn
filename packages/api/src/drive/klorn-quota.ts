/**
 * The Klorn drive's storage quota (step D3 of
 * docs/providers/unified-platform-plan.md; decision P3: the number is decided at
 * flip time, and the schema does not depend on it).
 *
 * Usage is computed, not stored: the sum of the recorded sizes of the user's
 * Klorn files (drive/klorn-drive-read.ts). The limit comes from the environment,
 * read per request:
 *
 *   KLORN_DRIVE_QUOTA_BYTES unset or blank  → no limit (the shipped default);
 *   a whole number of bytes                → that limit, for every user;
 *   anything else                          → uploads fail closed (503), and the
 *                                            log names the variable.
 *
 * One number for everyone is all P3 needs before the flip. A per-plan limit
 * replaces `klornDriveQuotaBytes` and nothing else: `assertWithinKlornQuota` is
 * the only place the limit is applied.
 *
 * Two uploads running at the same moment can both pass the check, so the quota
 * can be overshot by at most one file per concurrent upload. The upload rate
 * limit bounds that; it is a soft limit, not an accounting one.
 */

import { klornUsageBytes } from "./klorn-drive-read.js";
import { KlornDriveError } from "./klorn-errors.js";

export const KLORN_DRIVE_QUOTA_ENV = "KLORN_DRIVE_QUOTA_BYTES";
const WHOLE_BYTES = /^\d{1,15}$/;

/** The configured limit in bytes; null for none. Throws when the value is not usable. */
export function klornDriveQuotaBytes(): number | null {
  const raw = (process.env[KLORN_DRIVE_QUOTA_ENV] ?? "").trim();
  if (raw === "") return null;
  if (!WHOLE_BYTES.test(raw)) {
    console.error(`[DRIVE] ${KLORN_DRIVE_QUOTA_ENV} is not a whole number of bytes`);
    throw new KlornDriveError("storage-unavailable", { retryable: false });
  }
  return Number(raw);
}

/** Throws `quota-exceeded` when `incomingBytes` more would pass the user's limit. */
export async function assertWithinKlornQuota(
  userId: string,
  incomingBytes: number,
  limit: number | null = klornDriveQuotaBytes(),
): Promise<void> {
  if (limit === null) return;
  const used = await klornUsageBytes(userId);
  if (used + incomingBytes > limit) throw new KlornDriveError("quota-exceeded");
}
