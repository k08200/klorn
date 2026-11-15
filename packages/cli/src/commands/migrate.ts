import { takeBackup } from "../backup/take.js";
import type { Context } from "../context.js";
import { isUpToDate, type MigrationStatus, migrationStatus } from "../db/migrations.js";
import type { DbTarget } from "../db/target.js";
import { CliError } from "../errors.js";
import { confirmYesNo } from "../lib/confirm.js";
import { assertNotHostedProd } from "./restore.js";

function report(ctx: Context, target: DbTarget, status: MigrationStatus): void {
  const { io } = ctx.deps;
  if (ctx.opts.json) {
    io.out(
      JSON.stringify(
        {
          target: target.label,
          upToDate: isUpToDate(status),
          appliedCount: status.applied.length,
          pending: status.pending,
          failed: status.failed,
          unknown: status.unknown,
        },
        null,
        2,
      ),
    );
    return;
  }
  io.out(
    `${target.label}: ${status.applied.length} applied, ${status.pending.length} pending, ` +
      `${status.failed.length} failed`,
  );
  for (const name of status.pending) io.out(`  pending  ${name}`);
  for (const name of status.failed) io.out(`  failed   ${name}`);
  for (const name of status.unknown) {
    io.out(
      `  unknown  ${name}  (in the database, not in this code: a newer image, or a downgrade)`,
    );
  }
  io.out(isUpToDate(status) ? "up to date" : "not up to date");
}

export async function migrateStatus(ctx: Context): Promise<number> {
  const target = ctx.db();
  const status = await migrationStatus(ctx.pg(target), ctx.migrations(target));
  report(ctx, target, status);
  return isUpToDate(status) ? 0 : 1;
}

/**
 * `prisma migrate deploy` with the guard rails: a status read first, a
 * refusal while a migration is marked failed, confirmation (or --yes), and a
 * backup before anything is applied (unless --no-backup).
 */
export async function migrateDeploy(ctx: Context): Promise<number> {
  const { io } = ctx.deps;
  const target = ctx.db();
  assertNotHostedProd(ctx, target);
  const pg = ctx.pg(target);
  const source = ctx.migrations(target);
  const before = await migrationStatus(pg, source);
  if (before.failed.length > 0) {
    throw new CliError(
      `failed migration(s) on ${target.label}: ${before.failed.join(", ")} — inspect them and run ` +
        "`prisma migrate resolve` before deploying (docs/self-host-cli.md)",
    );
  }
  if (before.unknown.length > 0) {
    io.err(
      `warn: ${before.unknown.length} applied migration(s) are unknown to this code (downgrade?)`,
    );
  }
  if (before.pending.length === 0) {
    io.out(`${target.label}: nothing to apply — up to date`);
    return 0;
  }
  io.err(`${before.pending.length} migration(s) to apply on ${target.label}:`);
  for (const name of before.pending) io.err(`  ${name}`);
  await confirmYesNo(io, `apply them to ${target.label}?`, ctx.opts.yes);
  if (!ctx.opts.noBackup) await takeBackup(ctx, target, "pre-migrate");
  await source.deploy();
  const after = await migrationStatus(pg, source);
  report(ctx, target, after);
  return isUpToDate(after) ? 0 : 1;
}
