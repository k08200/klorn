/**
 * The limits and the switch of drive file summaries (step D4 of
 * docs/providers/unified-platform-plan.md). No import of the database or the
 * LLM, so the job, the routes and the tests share one set of numbers.
 *
 * Cost bounds, from the inside out:
 *   - a file is read only up to DRIVE_SUMMARY_MAX_SOURCE_BYTES, counted while
 *     it streams; past that it is skipped, never buffered whole;
 *   - the model sees at most DRIVE_SUMMARY_MAX_INPUT_CHARS of its text;
 *   - one file gets at most DRIVE_SUMMARY_RUNS_PER_FILE_PER_DAY model calls a
 *     UTC day, one user at most DRIVE_SUMMARIES_PER_USER_PER_DAY;
 *   - every call goes through the shared LLM layer, so the per-user daily cost
 *     cap, the global ceiling and BYOK apply as to any other call.
 */

import {
  DRIVE_SUMMARY_FLAGS,
  driveEnabled,
  driveSummariesEnabled,
  featureOpenTo,
} from "../config.js";
import { MAX_EXTRACTABLE_BYTES } from "../mail/email-attachment-text.js";
import type { DriveProviderName } from "./drive-providers.js";

/**
 * The most bytes read from a file for its summary: the attachment extractor's
 * own cap (mail/email-attachment-text.ts), since it is that extractor that reads
 * them.
 */
export const DRIVE_SUMMARY_MAX_SOURCE_BYTES = MAX_EXTRACTABLE_BYTES;
/** The most characters of extracted text the model sees (the attachment pipeline's 8,000). */
export const DRIVE_SUMMARY_MAX_INPUT_CHARS = 8_000;
/** The longest summary stored; the migration's CHECK holds the same bound. */
export const DRIVE_SUMMARY_MAX_CHARS = 1_000;
/** Summary model calls per user per UTC day, whatever the files. */
export const DRIVE_SUMMARIES_PER_USER_PER_DAY = 50;
/** Summary model calls for one file per UTC day (a retry or a re-summary counts). */
export const DRIVE_SUMMARY_RUNS_PER_FILE_PER_DAY = 3;
/**
 * The providers whose bytes a summary can read today: the Klorn drive (D4) and
 * Google Drive (D5d: `fetchForSummary` exports a Google format as text and
 * reads any other file with alt=media). A summary of any other provider
 * (ONEDRIVE until D6) waits (`source-unavailable`: PENDING, not an attempt, the
 * source backoff capped at a day) before any other check and without
 * connecting, so it neither spends its attempts on a refusal nor is SKIPPED as
 * an unsupported type, and it runs within a day of its provider joining here.
 */
export const DRIVE_SUMMARY_READABLE_PROVIDERS: ReadonlySet<DriveProviderName> = new Set([
  "KLORN",
  "GOOGLE",
]);

/**
 * Attempts before a summary is given up as FAILED. An attempt is counted when a
 * run claims its row, and given back when the run ends in a deferral (a cap, an
 * outage), so only content errors and runs that never finish spend it.
 */
export const DRIVE_SUMMARY_MAX_ATTEMPTS = 5;
/** The first retry waits this long; each further one doubles it, up to the cap. */
export const DRIVE_SUMMARY_RETRY_BASE_MS = 10 * 60_000;
export const DRIVE_SUMMARY_RETRY_MAX_MS = 6 * 60 * 60_000;
/** An outage (no provider answers) is retried from the same base, doubling up to a day. */
export const DRIVE_SUMMARY_OUTAGE_MAX_MS = 24 * 60 * 60_000;
/** The longest one model call may take: well inside the lease, so a run never outlives it. */
export const DRIVE_SUMMARY_LLM_TIMEOUT_MS = 90_000;
/** The longest a storage read (the object and all its bytes) may take; likewise inside the lease. */
export const DRIVE_SUMMARY_READ_TIMEOUT_MS = 60_000;
/**
 * A file that cannot be read for now (trashed, its provider hidden, storage off):
 * looked at again after this, doubling up to a day. Not an attempt.
 */
export const DRIVE_SUMMARY_SOURCE_DELAY_MS = 60 * 60_000;
/** How long a claimed row is held by its claimant before another may take it. */
export const DRIVE_SUMMARY_LEASE_MS = 5 * 60_000;
/** A provider's per-minute limit: try again after this, without counting an attempt. */
export const DRIVE_SUMMARY_RATE_LIMITED_DELAY_MS = 60_000;
/** Usage rows older than this many days are pruned by the job. */
export const DRIVE_SUMMARY_USAGE_KEEP_DAYS = 7;

const DAY_MS = 24 * 60 * 60_000;

/** Summaries act only while their own flag and the drive's are both on. Read per call. */
export function driveSummariesLive(): boolean {
  return driveSummariesEnabled() && driveEnabled();
}

/**
 * Summaries for this user: live, and the user in the cohort when either flag is
 * `cohort` (L23). What queues a file, serves a summary or searches summary text
 * asks this, never the global switch alone.
 */
export function driveSummariesOpenTo(userId: string): boolean {
  return driveSummariesLive() && featureOpenTo(userId, DRIVE_SUMMARY_FLAGS);
}

/** The UTC day of `now`, as "YYYY-MM-DD". */
export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The start of the UTC day after `now`: when the daily caps reset. */
export function nextUtcDay(now: Date): Date {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(start + DAY_MS);
}

/** The UTC day key `days` days before `now`. */
export function utcDayKeyBefore(now: Date, days: number): string {
  return utcDayKey(new Date(now.getTime() - days * DAY_MS));
}

/** The wait after the `attempts`-th failed attempt (1-based): doubling, capped. */
export function summaryRetryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  return Math.min(DRIVE_SUMMARY_RETRY_BASE_MS * 2 ** exponent, DRIVE_SUMMARY_RETRY_MAX_MS);
}

/** The wait for a file that cannot be read for now, after `streak` such waits in a row. */
export function summarySourceDelayMs(streak: number): number {
  const exponent = Math.max(0, Math.min(streak, 20));
  return Math.min(DRIVE_SUMMARY_SOURCE_DELAY_MS * 2 ** exponent, DRIVE_SUMMARY_OUTAGE_MAX_MS);
}

/** The wait after `streak` outages in a row before this one (0-based): doubling, capped at a day. */
export function summaryOutageDelayMs(streak: number): number {
  const exponent = Math.max(0, Math.min(streak, 20));
  return Math.min(DRIVE_SUMMARY_RETRY_BASE_MS * 2 ** exponent, DRIVE_SUMMARY_OUTAGE_MAX_MS);
}
