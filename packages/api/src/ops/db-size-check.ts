/**
 * Database size alarm.
 *
 * Supabase's free plan puts the database into read-only mode above 500 MB, and
 * then sync, sign-in and every other write fail; paid plans have their own disk
 * limit. Nothing watched the size: on 2026-10-16 production was at 446 MB (89%),
 * and 65% of that was duplicate attachment rows nobody had noticed for months.
 *
 * Hourly (automation scheduler): one pg_database_size() read, compared with
 * DB_SIZE_LIMIT_MB (default 500 = free plan). MB here is 10^6 bytes, the
 * conservative reading of the plan's "500 MB": if the plan counts MiB the alarm
 * is early, never late. pg_size_pretty prints MiB, so its "446 MB" is 468 here.
 * From 80% an ops Notification goes to every ADMIN; from 90% the same, plus
 * console.error and Sentry. One notification per level per UTC day, deduped
 * fleet-wide by its dedupeKey (ops/admin-ops-notification.ts). Loud output fires
 * only when this call created the notification, or, when nobody can receive one
 * (no ADMIN, or the write failed), once per process per day per level.
 *
 * Observability only: it never deletes or blocks anything.
 *
 * ── Runbook: "Database nearly full" alarm ──────────────────────────────────
 * 1. Find what grew: pg_total_relation_size per table, largest first. Mail
 *    bodies (EmailMessage) and attachment text (EmailAttachment) dominate.
 * 2. If one table grew from duplicates or a runaway writer, fix the writer
 *    first, then delete the excess and run VACUUM (FULL) on that table: a
 *    plain DELETE frees space for reuse inside the table but does not shrink
 *    the database size the plan measures.
 * 3. Otherwise raise the limit (a paid plan), then set DB_SIZE_LIMIT_MB to the
 *    new limit so the alarm tracks it.
 */

import { captureError } from "../sentry.js";
import { type AdminOpsDelivery, createAdminOpsNotifications } from "./admin-ops-notification.js";

export const DB_SIZE_DEFAULT_LIMIT_MB = 500;
export const DB_SIZE_WARN_RATIO = 0.8;
export const DB_SIZE_CRITICAL_RATIO = 0.9;

const BYTES_PER_MB = 1_000_000;
const PERCENT = 100;
const UTC_DAY_KEY_LENGTH = 10;
const ALARM_TITLE = "Database nearly full";

export type DbSizeLevel = "ok" | "warn" | "critical";

export interface DbSizeStatus {
  bytes: number;
  limitBytes: number;
  ratio: number;
  level: DbSizeLevel;
  checkedAt: number;
}

// Dedupe keys this process already made loud without a created notification.
const loudWithoutRecipient = new Set<string>();
let warnedInvalidLimit = false;

/**
 * DB_SIZE_LIMIT_MB as bytes. Missing or invalid → the free plan's 500 MB; a set
 * but unusable value ("8GB") is reported once, since on a bigger plan it would
 * otherwise page daily with no hint why.
 */
export function resolveDbSizeLimitBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DB_SIZE_LIMIT_MB?.trim() ?? "";
  const mb = Number(raw);
  if (raw !== "" && Number.isFinite(mb) && mb > 0) return mb * BYTES_PER_MB;
  if (raw !== "" && !warnedInvalidLimit) {
    warnedInvalidLimit = true;
    console.warn(
      `[DB-SIZE] DB_SIZE_LIMIT_MB=${JSON.stringify(raw)} is not a positive number of megabytes; using ${DB_SIZE_DEFAULT_LIMIT_MB}.`,
    );
  }
  return DB_SIZE_DEFAULT_LIMIT_MB * BYTES_PER_MB;
}

export function classifyDbSize(bytes: number, limitBytes: number): DbSizeLevel {
  const ratio = bytes / limitBytes;
  if (ratio >= DB_SIZE_CRITICAL_RATIO) return "critical";
  if (ratio >= DB_SIZE_WARN_RATIO) return "warn";
  return "ok";
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / BYTES_PER_MB)} MB`;
}

function formatAlarmMessage(status: DbSizeStatus): string {
  const pct = Math.floor(status.ratio * PERCENT);
  const used = `${pct}%, ${formatMb(status.bytes)} used`;
  if (status.ratio >= 1) {
    return `Database is over its ${formatMb(status.limitBytes)} limit (${used}). It is likely read-only now: sync, sign-in and every write fail.`;
  }
  return `Database at ${pct}% of its ${formatMb(status.limitBytes)} limit (${formatMb(status.bytes)} used). At the limit it goes read-only: sync, sign-in and every write fail.`;
}

function shouldBeLoud(delivery: AdminOpsDelivery | null, dedupeKey: string): boolean {
  if (delivery && delivery.created > 0) return true;
  const unreachable = delivery === null || delivery.recipients === 0;
  return unreachable && !loudWithoutRecipient.has(dedupeKey);
}

function rememberLoud(dedupeKey: string, dayKey: string): void {
  // Bounded: only today's keys are kept.
  for (const key of loudWithoutRecipient) {
    if (!key.endsWith(dayKey)) loudWithoutRecipient.delete(key);
  }
  loudWithoutRecipient.add(dedupeKey);
}

async function raiseAlarm(status: DbSizeStatus): Promise<void> {
  const dayKey = new Date(status.checkedAt).toISOString().slice(0, UTC_DAY_KEY_LENGTH);
  const dedupeKey = `db-size:${status.level}:${dayKey}`;
  const message = formatAlarmMessage(status);

  let delivery: AdminOpsDelivery | null = null;
  try {
    delivery = await createAdminOpsNotifications({ dedupeKey, title: ALARM_TITLE, message });
  } catch (err) {
    console.warn("[DB-SIZE] ops notification failed:", err);
  }
  if (status.level !== "critical" || !shouldBeLoud(delivery, dedupeKey)) return;

  if (!delivery || delivery.created === 0) rememberLoud(dedupeKey, dayKey);
  console.error(`[DB-SIZE] ${message}`);
  captureError(new Error("database size near its plan limit"), {
    tags: { scope: "db-size", level: status.level },
    extra: { bytes: status.bytes, limitBytes: status.limitBytes, ratio: status.ratio },
  });
}

/**
 * The hourly check (automation scheduler). Throws only if the size read fails;
 * alarm delivery failures are logged, never thrown.
 */
export async function runDbSizeCheck(now: number = Date.now()): Promise<DbSizeStatus> {
  // Lazy db import, as in admin-ops-notification.ts.
  const { prisma } = await import("../db.js");
  const rows = await prisma.$queryRaw<Array<{ bytes: bigint }>>`
    SELECT pg_database_size(current_database()) AS bytes
  `;
  const size = rows[0]?.bytes;
  if (size === undefined || size === null) throw new Error("pg_database_size returned no size");
  const bytes = Number(size);
  const limitBytes = resolveDbSizeLimitBytes();
  const status: DbSizeStatus = {
    bytes,
    limitBytes,
    ratio: bytes / limitBytes,
    level: classifyDbSize(bytes, limitBytes),
    checkedAt: now,
  };
  console.log(
    `[DB-SIZE] ${formatMb(bytes)} of ${formatMb(limitBytes)} (${Math.floor(status.ratio * PERCENT)}%)`,
  );
  if (status.level !== "ok") await raiseAlarm(status);
  return status;
}

/** Test-only: forget the loud-key memory and the invalid-limit warning. */
export function __resetDbSizeCheck(): void {
  loudWithoutRecipient.clear();
  warnedInvalidLimit = false;
}
