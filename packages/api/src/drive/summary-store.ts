/**
 * The summary queue and its records (step D4 of
 * docs/providers/unified-platform-plan.md): the only module that writes
 * DriveFileSummary or DriveSummaryUsage (drive-file-guard.test.ts).
 *
 * Every query names the user, except the job's two system queries (the due rows
 * of every user, and the prune of past days), each marked `system:` below. The
 * job then acts on each row with that row's user named again.
 *
 * A row is claimed before it runs: the claim moves `nextAttemptAt` a lease ahead,
 * conditional on the value the claimant read, so two processes (the job and an
 * on-demand request, or two instances) never run the same row at once.
 *
 * Runs on the global client, like the other drive modules: when the app role
 * drops BYPASSRLS, the per-user queries move to `withTenant` and the system ones
 * to `withSystem` (db-tenant.ts).
 */

import type { DriveFileSummaryWire, DriveSummaryErrorCode } from "@klorn/contract";
import type { DriveSummaryStatus, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { escapeLikePattern } from "./drive-read.js";
import {
  DRIVE_SUMMARIES_PER_USER_PER_DAY,
  DRIVE_SUMMARY_LEASE_MS,
  DRIVE_SUMMARY_RUNS_PER_FILE_PER_DAY,
  DRIVE_SUMMARY_SEARCH_MAX_MATCHES,
  DRIVE_SUMMARY_USAGE_KEEP_DAYS,
  utcDayKey,
  utcDayKeyBefore,
} from "./summary-policy.js";

export interface SummaryRow {
  readonly id: string;
  readonly userId: string;
  readonly driveFileId: string;
  readonly status: DriveSummaryStatus;
  readonly summary: string | null;
  readonly sourceEtag: string | null;
  readonly error: string | null;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly runsDayKey: string | null;
  readonly runsToday: number;
  readonly summarizedAt: Date | null;
}

const ROW_SELECT = {
  id: true,
  userId: true,
  driveFileId: true,
  status: true,
  summary: true,
  sourceEtag: true,
  error: true,
  attempts: true,
  nextAttemptAt: true,
  runsDayKey: true,
  runsToday: true,
  summarizedAt: true,
} as const satisfies Prisma.DriveFileSummarySelect;

/** The columns the wire shape is built from. */
export const SUMMARY_WIRE_SELECT = {
  status: true,
  summary: true,
  error: true,
  summarizedAt: true,
} as const satisfies Prisma.DriveFileSummarySelect;

/** A summary as the wire carries it: the text only when DONE, the error as its code. */
export function toDriveSummaryWire(
  row: Pick<SummaryRow, "status" | "summary" | "error" | "summarizedAt">,
): DriveFileSummaryWire {
  const done = row.status === "DONE";
  return {
    status: row.status,
    text: done ? row.summary : null,
    error: (row.error as DriveSummaryErrorCode | null) ?? null,
    summarizedAt: done && row.summarizedAt ? row.summarizedAt.toISOString() : null,
  };
}

/** A row the queue acts on: its id and its user, always together. */
export type SummaryRef = Pick<SummaryRow, "id" | "userId">;

/** What a new version of a file resets: the old summary is of other bytes. */
const REQUEUED = {
  status: "PENDING",
  summary: null,
  model: null,
  costMicroCents: 0,
  error: null,
  attempts: 0,
  summarizedAt: null,
} as const satisfies Prisma.DriveFileSummaryUpdateManyMutationInput;

/**
 * Queue a summary of the user's file at version `etag`. A new file gets a PENDING
 * row due now. An existing row is left alone at the same version, except a
 * FAILED one when `retryFailed` (an on-demand request); at another version it is
 * queued again from scratch. The caller has checked that the file is the user's.
 */
export async function enqueueDriveFileSummary(
  userId: string,
  driveFileId: string,
  etag: string | null,
  options: { readonly retryFailed?: boolean } = {},
  now: Date = new Date(),
): Promise<SummaryRow> {
  const row = await prisma.driveFileSummary.upsert({
    where: { driveFileId, userId },
    create: { driveFileId, userId, sourceEtag: etag, nextAttemptAt: now },
    update: {},
    select: ROW_SELECT,
  });
  const changed = row.sourceEtag !== etag;
  const retry = options.retryFailed === true && row.status === "FAILED";
  if (!changed && !retry) return row;
  const reset = { ...REQUEUED, sourceEtag: etag, nextAttemptAt: now };
  await prisma.driveFileSummary.updateMany({ where: { id: row.id, userId }, data: reset });
  return { ...row, ...reset };
}

/** The summary row of the user's file, or null. */
export async function findSummaryRow(
  userId: string,
  driveFileId: string,
): Promise<SummaryRow | null> {
  return await prisma.driveFileSummary.findUnique({
    where: { driveFileId, userId },
    select: ROW_SELECT,
  });
}

/** system: due PENDING rows of every user, oldest due first (the job). */
export async function dueSummaries(now: Date, take: number): Promise<SummaryRow[]> {
  return await prisma.driveFileSummary.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: now } },
    orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
    take,
    select: ROW_SELECT,
  });
}

/** Take a due row for DRIVE_SUMMARY_LEASE_MS. False when another claimant took it first. */
export async function claimSummary(
  row: Pick<SummaryRow, "id" | "userId" | "nextAttemptAt">,
  now: Date,
): Promise<boolean> {
  if (row.nextAttemptAt.getTime() > now.getTime()) return false;
  const claimed = await prisma.driveFileSummary.updateMany({
    where: { id: row.id, userId: row.userId, status: "PENDING", nextAttemptAt: row.nextAttemptAt },
    data: { nextAttemptAt: new Date(now.getTime() + DRIVE_SUMMARY_LEASE_MS) },
  });
  return claimed.count === 1;
}

/** Model calls already made for this file today. */
export function fileRunsToday(
  row: Pick<SummaryRow, "runsDayKey" | "runsToday">,
  now: Date,
): number {
  return row.runsDayKey === utcDayKey(now) ? row.runsToday : 0;
}

/** Count one model call for this file; false when its daily count is spent. */
export async function countFileRun(row: SummaryRow, now: Date): Promise<boolean> {
  const used = fileRunsToday(row, now);
  if (used >= DRIVE_SUMMARY_RUNS_PER_FILE_PER_DAY) return false;
  await prisma.driveFileSummary.updateMany({
    where: { id: row.id, userId: row.userId },
    data: { runsDayKey: utcDayKey(now), runsToday: used + 1 },
  });
  return true;
}

/** Whether the user's daily count is already spent: a read, checked before any byte is fetched. */
export async function userDailyCountSpent(userId: string, now: Date): Promise<boolean> {
  const usage = await prisma.driveSummaryUsage.findUnique({
    where: { userId_dayKey: { userId, dayKey: utcDayKey(now) } },
    select: { count: true },
  });
  return (usage?.count ?? 0) >= DRIVE_SUMMARIES_PER_USER_PER_DAY;
}

/**
 * Count one summary call against the user's day; false past the daily count.
 * The increment is atomic, and the count after it decides, so concurrent
 * claimants cannot both pass the last slot.
 */
export async function reserveUserSummary(userId: string, now: Date): Promise<boolean> {
  const dayKey = utcDayKey(now);
  const usage = await prisma.driveSummaryUsage.upsert({
    where: { userId_dayKey: { userId, dayKey } },
    create: { userId, dayKey, count: 1 },
    update: { count: { increment: 1 } },
    select: { count: true },
  });
  return usage.count <= DRIVE_SUMMARIES_PER_USER_PER_DAY;
}

export interface SummaryDone {
  readonly summary: string;
  readonly model: string;
  readonly costMicroCents: number;
  readonly sourceEtag: string | null;
}

export async function markSummaryDone(
  ref: SummaryRef,
  done: SummaryDone,
  now: Date,
): Promise<void> {
  await prisma.driveFileSummary.updateMany({
    where: { id: ref.id, userId: ref.userId },
    data: { ...done, status: "DONE", error: null, attempts: 0, summarizedAt: now },
  });
}

export async function markSummarySkipped(
  ref: SummaryRef,
  error: DriveSummaryErrorCode,
  sourceEtag: string | null,
): Promise<void> {
  await prisma.driveFileSummary.updateMany({
    where: { id: ref.id, userId: ref.userId },
    data: { status: "SKIPPED", error, sourceEtag, summary: null },
  });
}

/** Leave the row PENDING until `until`, with the reason; not a failed attempt. */
export async function markSummaryDeferred(
  ref: SummaryRef,
  error: DriveSummaryErrorCode,
  until: Date,
): Promise<void> {
  await prisma.driveFileSummary.updateMany({
    where: { id: ref.id, userId: ref.userId },
    data: { status: "PENDING", error, nextAttemptAt: until },
  });
}

/** A failed attempt: PENDING again at `retryAt`, or FAILED when `retryAt` is null. */
export async function markSummaryAttemptFailed(
  ref: SummaryRef,
  error: DriveSummaryErrorCode,
  attempts: number,
  retryAt: Date | null,
): Promise<void> {
  await prisma.driveFileSummary.updateMany({
    where: { id: ref.id, userId: ref.userId },
    data:
      retryAt === null
        ? { status: "FAILED", error, attempts }
        : { status: "PENDING", error, attempts, nextAttemptAt: retryAt },
  });
}

/**
 * The ids of the user's files whose summary contains the text (the search adds
 * them to the name matches), newest summary first, at most
 * DRIVE_SUMMARY_SEARCH_MAX_MATCHES. `%`, `_` and `\` match themselves.
 */
export async function driveFileIdsMatchingSummary(userId: string, text: string): Promise<string[]> {
  const rows = await prisma.driveFileSummary.findMany({
    where: {
      userId,
      status: "DONE",
      summary: { contains: escapeLikePattern(text), mode: "insensitive" },
    },
    orderBy: [{ summarizedAt: "desc" }, { id: "desc" }],
    take: DRIVE_SUMMARY_SEARCH_MAX_MATCHES,
    select: { driveFileId: true },
  });
  return rows.map((row) => row.driveFileId);
}

/** system: drop the usage rows of days past the keep window (the job). */
export async function pruneSummaryUsage(now: Date): Promise<number> {
  const deleted = await prisma.driveSummaryUsage.deleteMany({
    where: { dayKey: { lt: utcDayKeyBefore(now, DRIVE_SUMMARY_USAGE_KEEP_DAYS) } },
  });
  return deleted.count;
}
