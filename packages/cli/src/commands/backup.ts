import { type PruneReport, prune } from "../backup/prune.js";
import { listBackups } from "../backup/store.js";
import { takeBackup } from "../backup/take.js";
import type { Context } from "../context.js";
import { formatBytes } from "../lib/format.js";

export async function backupCreate(ctx: Context): Promise<number> {
  const backup = await takeBackup(ctx, ctx.db(), ctx.opts.label);
  if (ctx.opts.json) {
    ctx.deps.io.out(JSON.stringify({ backup }, null, 2));
  } else {
    ctx.deps.io.out(`${backup.path}  ${formatBytes(backup.bytes)}  sha256 ${backup.sha256}`);
  }
  return 0;
}

export function backupList(ctx: Context): Promise<number> {
  const backups = listBackups(ctx.backupDir);
  const { io } = ctx.deps;
  if (ctx.opts.json) {
    io.out(JSON.stringify({ dir: ctx.backupDir, backups }, null, 2));
  } else if (backups.length === 0) {
    io.out(`no backups in ${ctx.backupDir}`);
  } else {
    for (const b of backups) {
      const sum = b.checksum ? "sha256" : "NO CHECKSUM";
      io.out(`${b.name}  ${formatBytes(b.bytes).padStart(10)}  ${sum}`);
    }
    io.out(`${backups.length} backup(s) in ${ctx.backupDir}`);
  }
  return Promise.resolve(0);
}

function printPruneReport(ctx: Context, report: PruneReport): void {
  const { io } = ctx.deps;
  if (report.total === 0) {
    io.out(`no backups in ${report.dir}`);
    return;
  }
  const { candidates } = report;
  if (candidates.length === 0) {
    io.out(
      `nothing to prune: ${report.total} backup(s) in ${report.dir} are all within the rules (the newest is always kept)`,
    );
    return;
  }
  const verb = report.dryRun ? "would delete" : "deleting";
  io.out(
    `${verb} ${candidates.length} of ${report.total} backup(s) in ${report.dir} (${formatBytes(report.candidateBytes)}):`,
  );
  for (const c of candidates) io.out(`  ${c.name}  ${formatBytes(c.bytes).padStart(10)}`);
  if (report.dryRun) {
    io.out("dry run: nothing deleted. re-run with --yes to delete");
    return;
  }
  io.out(
    `deleted ${report.deleted.length} backup(s), freed ${formatBytes(report.freedBytes)}; ${report.kept} kept`,
  );
}

function pruneAndReport(ctx: Context): number {
  const report = prune(ctx);
  const { io } = ctx.deps;
  if (report.ignored > 0) {
    io.err(
      `warn: ignoring ${report.ignored} file(s) named like a backup but with an impossible timestamp`,
    );
  }
  if (ctx.opts.json) io.out(JSON.stringify(report, null, 2));
  else printPruneReport(ctx, report);
  for (const failure of report.errors) io.err(`error: ${failure.file}: ${failure.error}`);
  return report.errors.length > 0 ? 1 : 0;
}

/** Retention. A dry run unless --yes; every per-file failure is reported and exits 1. */
export function backupPrune(ctx: Context): Promise<number> {
  // A throw from the planning step is a rejected promise, like every other handler.
  return Promise.resolve().then(() => pruneAndReport(ctx));
}
