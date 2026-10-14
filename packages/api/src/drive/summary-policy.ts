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

import { driveEnabled, driveSummariesEnabled } from "../config.js";
import { MAX_EXTRACTABLE_BYTES } from "../mail/email-attachment-text.js";

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
/** Failed attempts before a summary is given up as FAILED. */
export const DRIVE_SUMMARY_MAX_ATTEMPTS = 5;
/** The first retry waits this long; each further one doubles it, up to the cap. */
export const DRIVE_SUMMARY_RETRY_BASE_MS = 10 * 60_000;
export const DRIVE_SUMMARY_RETRY_MAX_MS = 6 * 60 * 60_000;
/** How long a claimed row is held by its claimant before another may take it. */
export const DRIVE_SUMMARY_LEASE_MS = 5 * 60_000;
/** A provider's per-minute limit: try again after this, without counting an attempt. */
export const DRIVE_SUMMARY_RATE_LIMITED_DELAY_MS = 60_000;
/** A source that cannot be read right now (storage off, connector off): look again after this. */
export const DRIVE_SUMMARY_SOURCE_DELAY_MS = 60 * 60_000;
/** The most files a summary-text search adds to the name matches. */
export const DRIVE_SUMMARY_SEARCH_MAX_MATCHES = 200;
/** Usage rows older than this many days are pruned by the job. */
export const DRIVE_SUMMARY_USAGE_KEEP_DAYS = 7;

const DAY_MS = 24 * 60 * 60_000;

/** Summaries act only while their own flag and the drive's are both on. Read per call. */
export function driveSummariesLive(): boolean {
  return driveSummariesEnabled() && driveEnabled();
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
