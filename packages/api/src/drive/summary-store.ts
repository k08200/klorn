/**
 * The summary queue and its records (step D4 of
 * docs/providers/unified-platform-plan.md): the only module that writes
 * DriveFileSummary or DriveSummaryUsage (drive-file-guard.test.ts).
 *
 * Every query names the user, except the job's system query (the users with due
 * rows) and the prune of past days, each marked `system:` below; and the first
 * enqueue, whose upsert names the unique key only (so Postgres runs it as one
 * INSERT ... ON CONFLICT) and then refuses a row of another user.
 *
 * Leases. A run starts by claiming its row: the claim moves `nextAttemptAt` a
 * lease ahead and counts an attempt, conditional on the values the claimant
 * read, so two processes never run one row at once, and a row whose run never
 * ends (a crash, a freeze) spends its attempts and ends FAILED `interrupted`.
 * Every write of a run's outcome is conditional on the lease still holding: the
 * row is PENDING, its `nextAttemptAt` is the lease's end and its `sourceEtag` the
 * version the run read. A run that lost its lease (expired and reclaimed, or the
 * file changed meanwhile) writes nothing.
 *
 * Runs on the global client, like the other drive modules: when the app role
 * drops BYPASSRLS, the per-user queries move to `withTenant` and the system ones
 * to `withSystem` (db-tenant.ts).
 */

import type { DriveFileSummaryWire, DriveSummaryErrorCode } from "@klorn/contract";
import type { DriveSummaryStatus, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import {
  DRIVE_SUMMARIES_PER_USER_PER_DAY,
  DRIVE_SUMMARY_LEASE_MS,
  DRIVE_SUMMARY_MAX_ATTEMPTS,
  DRIVE_SUMMARY_RUNS_PER_FILE_PER_DAY,
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
  readonly outageStreak: number;
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
  outageStreak: true,
  nextAttemptAt: true,
  runsDayKey: true,
  runsToday: true,
  summarizedAt: true,
} as const satisfies Prisma.DriveFileSummarySelect;

/** A claimed row: the snapshot the claimant read, and when its lease ends. */
export interface SummaryLease {
  readonly row: SummaryRow;
  readonly until: Date;
}

/** Every error code, so a stored one is checked rather than cast. */
const ERROR_CODES = {
  folder: true,
  "unsupported-type": true,
  "too-large": true,
  "no-text": true,
  "object-missing": true,
  "source-unavailable": true,
  "storage-error": true,
  "cost-cap": true,
  "daily-limit": true,
  "file-limit": true,
  "rate-limited": true,
  "llm-unavailable": true,
  "llm-bad-output": true,
  interrupted: true,
  internal: true,
} as const satisfies Record<DriveSummaryErrorCode, true>;

function isErrorCode(value: string): value is DriveSummaryErrorCode {
  return Object.hasOwn(ERROR_CODES, value);
}

/** A stored code as the wire's union; one the union does not know reads as `internal`. */
function errorCodeOf(value: string | null): DriveSummaryErrorCode | null {
  if (value === null) return null;
  return isErrorCode(value) ? value : "internal";
}

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
    error: errorCodeOf(row.error),
    summarizedAt: done && row.summarizedAt ? row.summarizedAt.toISOString() : null,
  };
}

/** What a new version of a file resets: the old summary is of other bytes. */
const REQUEUED = {
  status: "PENDING",
  summary: null,
  model: null,
  costMicroCents: 0,
  error: null,
  attempts: 0,
  outageStreak: 0,
  summarizedAt: null,
} as const satisfies Prisma.DriveFileSummaryUpdateManyMutationInput;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/** The file's row, created PENDING when it has none. A concurrent first enqueue answers the winner's. */
async function upsertQueued(
  userId: string,
  driveFileId: string,
  etag: string | null,
  now: Date,
): Promise<SummaryRow> {
  try {
    return await prisma.driveFileSummary.upsert({
      where: { driveFileId },
      create: { driveFileId, userId, sourceEtag: etag, nextAttemptAt: now },
      update: {},
      select: ROW_SELECT,
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await findSummaryRow(userId, driveFileId);
    if (winner === null) throw err;
    return winner;
  }
}

/**
 * Queue a summary of the user's file at version `etag`. A new file gets a PENDING
 * row due now. An existing row is left alone at the same version, except a
 * FAILED one when `retryFailed` (an on-demand request); at another version it is
 * queued again from scratch, but a PENDING row keeps its `nextAttemptAt`: it may
 * be a live lease (whose run then finds the version changed and writes nothing)
 * or a deferral. The caller has checked that the file is the user's.
 */
export async function enqueueDriveFileSummary(
  userId: string,
  driveFileId: string,
  etag: string | null,
  options: { readonly retryFailed?: boolean } = {},
  now: Date = new Date(),
): Promise<SummaryRow> {
  const row = await upsertQueued(userId, driveFileId, etag, now);
  if (row.userId !== userId) throw new Error("drive summary: the file is another user's");
  const changed = row.sourceEtag !== etag;
  const retry = options.retryFailed === true && row.status === "FAILED";
  if (!changed && !retry) return row;
  const keepsTime = row.status === "PENDING" && row.nextAttemptAt.getTime() > now.getTime();
  const reset = {
    ...REQUEUED,
    sourceEtag: etag,
    nextAttemptAt: keepsTime ? row.nextAttemptAt : now,
  };
  const written = await prisma.driveFileSummary.updateMany({
    where: { id: row.id, userId, status: row.status, sourceEtag: row.sourceEtag },
    data: reset,
  });
  return written.count === 1 ? { ...row, ...reset } : row;
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

/** system: the users with due rows, by their oldest due row, at most `take` (the job). */
export async function dueSummaryUsers(now: Date, take: number): Promise<string[]> {
  const groups = await prisma.driveFileSummary.groupBy({
    by: ["userId"],
    where: { status: "PENDING", nextAttemptAt: { lte: now } },
    _min: { nextAttemptAt: true },
    orderBy: { _min: { nextAttemptAt: "asc" } },
    take,
  });
  return groups.map((group) => group.userId);
}

/** One user's due rows, oldest due first, at most `take`. */
export async function dueSummariesOf(
  userId: string,
  now: Date,
  take: number,
): Promise<SummaryRow[]> {
  return await prisma.driveFileSummary.findMany({
    where: { userId, status: "PENDING", nextAttemptAt: { lte: now } },
    orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
    take,
    select: ROW_SELECT,
  });
}

/**
 * Take a due row for DRIVE_SUMMARY_LEASE_MS and count an attempt. Null when it is
 * not due, another claimant took it first, or its attempts are spent: a row
 * claimed DRIVE_SUMMARY_MAX_ATTEMPTS times without an outcome is FAILED
 * `interrupted` instead of run again.
 */
export async function claimSummary(row: SummaryRow, now: Date): Promise<SummaryLease | null> {
  if (row.nextAttemptAt.getTime() > now.getTime()) return null;
  const unchanged = {
    id: row.id,
    userId: row.userId,
    status: "PENDING",
    nextAttemptAt: row.nextAttemptAt,
  } as const;
  if (row.attempts >= DRIVE_SUMMARY_MAX_ATTEMPTS) {
    await prisma.driveFileSummary.updateMany({
      where: unchanged,
      data: { status: "FAILED", error: "interrupted" },
    });
    return null;
  }
  const until = new Date(now.getTime() + DRIVE_SUMMARY_LEASE_MS);
  const claimed = await prisma.driveFileSummary.updateMany({
    where: unchanged,
    data: { nextAttemptAt: until, attempts: { increment: 1 } },
  });
  return claimed.count === 1 ? { row: { ...row, attempts: row.attempts + 1 }, until } : null;
}

/** The `where` of every outcome write: the lease still holds. */
function leased(lease: SummaryLease): Prisma.DriveFileSummaryWhereInput {
  return {
    id: lease.row.id,
    userId: lease.row.userId,
    status: "PENDING",
    nextAttemptAt: lease.until,
    sourceEtag: lease.row.sourceEtag,
  };
}

/** Model calls already made for this file today. */
export function fileRunsToday(
  row: Pick<SummaryRow, "runsDayKey" | "runsToday">,
  now: Date,
): number {
  return row.runsDayKey === utcDayKey(now) ? row.runsToday : 0;
}

/**
 * Count one model call for this file; false when its daily count is spent. Each
 * update checks the count in its own `where`, so two holders of the same snapshot
 * cannot both take the last call.
 */
export async function countFileRun(lease: SummaryLease, now: Date): Promise<boolean> {
  const today = utcDayKey(now);
  const ref = { id: lease.row.id, userId: lease.row.userId };
  const sameDay = await prisma.driveFileSummary.updateMany({
    where: { ...ref, runsDayKey: today, runsToday: { lt: DRIVE_SUMMARY_RUNS_PER_FILE_PER_DAY } },
    data: { runsToday: { increment: 1 } },
  });
  if (sameDay.count === 1) return true;
  const newDay = await prisma.driveFileSummary.updateMany({
    where: { ...ref, OR: [{ runsDayKey: null }, { runsDayKey: { not: today } }] },
    data: { runsDayKey: today, runsToday: 1 },
  });
  return newDay.count === 1;
}

/** Give back a file's call that never reached a model (a refusal or an outage). */
export async function releaseFileRun(lease: SummaryLease, now: Date): Promise<void> {
  await prisma.driveFileSummary.updateMany({
    where: {
      id: lease.row.id,
      userId: lease.row.userId,
      runsDayKey: utcDayKey(now),
      runsToday: { gt: 0 },
    },
    data: { runsToday: { increment: -1 } },
  });
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

/** Give back a reserved call that never reached a model, or that the count refused. */
export async function releaseUserSummary(userId: string, now: Date): Promise<void> {
  await prisma.driveSummaryUsage.updateMany({
    where: { userId, dayKey: utcDayKey(now), count: { gt: 0 } },
    data: { count: { increment: -1 } },
  });
}

export interface SummaryDone {
  readonly summary: string;
  readonly model: string;
  readonly costMicroCents: number;
  readonly sourceEtag: string | null;
}

/** Each outcome write answers whether the lease still held (false: nothing was written). */
async function writeOutcome(
  lease: SummaryLease,
  data: Prisma.DriveFileSummaryUpdateManyMutationInput,
): Promise<boolean> {
  const written = await prisma.driveFileSummary.updateMany({ where: leased(lease), data });
  return written.count === 1;
}

export async function markSummaryDone(
  lease: SummaryLease,
  done: SummaryDone,
  now: Date,
): Promise<boolean> {
  return await writeOutcome(lease, {
    ...done,
    status: "DONE",
    error: null,
    attempts: 0,
    outageStreak: 0,
    summarizedAt: now,
  });
}

export async function markSummarySkipped(
  lease: SummaryLease,
  error: DriveSummaryErrorCode,
  sourceEtag: string | null,
): Promise<boolean> {
  return await writeOutcome(lease, {
    status: "SKIPPED",
    error,
    sourceEtag,
    summary: null,
    attempts: 0,
  });
}

/**
 * PENDING until `until`, with the reason. Not an attempt: the claim's count is
 * given back. `outage` counts toward the outage backoff instead.
 */
export async function markSummaryDeferred(
  lease: SummaryLease,
  error: DriveSummaryErrorCode,
  until: Date,
  options: { readonly outage?: boolean } = {},
): Promise<boolean> {
  return await writeOutcome(lease, {
    status: "PENDING",
    error,
    nextAttemptAt: until,
    attempts: lease.row.attempts - 1,
    ...(options.outage === true && { outageStreak: lease.row.outageStreak + 1 }),
  });
}

/** A failed attempt (the claim counted it): PENDING again at `retryAt`, or FAILED when null. */
export async function markSummaryAttemptFailed(
  lease: SummaryLease,
  error: DriveSummaryErrorCode,
  retryAt: Date | null,
): Promise<boolean> {
  return await writeOutcome(
    lease,
    retryAt === null
      ? { status: "FAILED", error }
      : { status: "PENDING", error, nextAttemptAt: retryAt },
  );
}

/** system: drop the usage rows of days past the keep window (the job). */
export async function pruneSummaryUsage(now: Date): Promise<number> {
  const deleted = await prisma.driveSummaryUsage.deleteMany({
    where: { dayKey: { lt: utcDayKeyBefore(now, DRIVE_SUMMARY_USAGE_KEEP_DAYS) } },
  });
  return deleted.count;
}
