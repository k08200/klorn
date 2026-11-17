import { existsSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { Context } from "../context.js";
import { CliError, errorMessage, UsageError } from "../errors.js";
import { type BackupEntry, checksumPath, ensureBackupDir, listBackups } from "./store.js";

/**
 * Retention for the backup directory. Deletion is the one thing in this CLI
 * that cannot be undone, so every choice here leans toward keeping a file:
 *
 *  - only `klorn-<stamp>[-<label>].dump` regular files (the CLI's own naming,
 *    store.ts) and their `.sha256` sidecars are ever candidates — never a
 *    symlink, a directory, a `.partial` (a backup in progress), an orphan
 *    sidecar, or any other file that happens to sit in the directory;
 *  - the newest backup is never deleted, whatever the rules say;
 *  - with both rules, a backup goes only when BOTH select it (it is beyond the
 *    newest N and older than D days): either rule alone protects it;
 *  - the dump is removed before its sidecar, so a failure in between leaves a
 *    sidecar with no dump (inert) rather than a dump nobody can verify.
 */

const DAY_MS = 86_400_000;

export interface PruneRules {
  /** Keep this many of the newest backups. */
  keep?: number;
  /** Delete only backups older than this many days. */
  olderThanDays?: number;
}

export interface PrunePlan {
  /** Newest first. */
  kept: BackupEntry[];
  /** Newest first. */
  doomed: BackupEntry[];
  /** Files named like a backup whose timestamp is not a real date: never touched, never counted. */
  ignored: number;
}

export interface PruneCandidate {
  name: string;
  path: string;
  /** Space freed: the dump plus its checksum sidecar. */
  bytes: number;
  createdAt: string;
  label: string | null;
  checksum: boolean;
}

export interface PruneFailure {
  file: string;
  error: string;
}

export interface PruneReport {
  dir: string;
  dryRun: boolean;
  rules: { keep: number | null; olderThanDays: number | null };
  /** Backups the CLI recognises in the directory (ignored files excluded). */
  total: number;
  /** total minus candidates: what stays when the run succeeds. */
  kept: number;
  ignored: number;
  candidates: PruneCandidate[];
  candidateBytes: number;
  /** Backups removed in full (dump and sidecar). Empty on a dry run. */
  deleted: string[];
  freedBytes: number;
  errors: PruneFailure[];
}

export interface PruneOps {
  /** Must unlink the path itself — never follow a symlink. */
  remove(path: string): void;
}

/** The stamp as a timestamp, or NaN when it is not a real date (month 13, Feb 30, ...). */
function stampMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return Number.NaN;
  return new Date(ms).toISOString().replace(".000Z", "Z") === iso ? ms : Number.NaN;
}

/** Which backups the rules select. Pure: no file is read or touched. */
export function planPrune(
  entries: readonly BackupEntry[],
  rules: PruneRules,
  nowMs: number,
): PrunePlan {
  const dated = entries
    .map((entry) => ({ entry, ms: stampMs(entry.createdAt) }))
    .filter((item) => !Number.isNaN(item.ms))
    .sort((a, b) => b.ms - a.ms || b.entry.name.localeCompare(a.entry.name));
  const cutoff =
    rules.olderThanDays === undefined ? undefined : nowMs - rules.olderThanDays * DAY_MS;
  const kept: BackupEntry[] = [];
  const doomed: BackupEntry[] = [];
  for (const [rank, { entry, ms }] of dated.entries()) {
    const protectedByRank = rank === 0 || (rules.keep !== undefined && rank < rules.keep);
    const protectedByAge = cutoff !== undefined && !(ms < cutoff);
    (protectedByRank || protectedByAge ? kept : doomed).push(entry);
  }
  return { kept, doomed, ignored: entries.length - dated.length };
}

const realOrResolved = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
const forms = (path: string): string[] => [resolve(path), realOrResolved(path)];

/** `--backup-dir /` or `--backup-dir ~` is a typo that must never become a delete. */
function assertNotRootOrHome(ctx: Context): void {
  const dir = forms(ctx.backupDir);
  const guarded = ["/", ctx.deps.homeDir, ctx.deps.env.HOME].filter((p): p is string => Boolean(p));
  if (guarded.some((path) => forms(path).some((form) => dir.includes(form)))) {
    throw new CliError(
      `refusing to prune ${ctx.backupDir}: it is the filesystem root or a home directory — point --backup-dir at a dedicated backup directory`,
    );
  }
}

interface Item {
  entry: BackupEntry;
  sidecar: { path: string; bytes: number } | null;
  /** Why this backup cannot be pruned safely; it is then left whole. */
  problem: PruneFailure | null;
}

/** lstat, not stat: a symlinked sidecar is never followed, and never deleted either. */
function inspect(entry: BackupEntry): Item {
  const path = checksumPath(entry.path);
  try {
    const st = lstatSync(path);
    if (!st.isFile()) {
      return {
        entry,
        sidecar: null,
        problem: { file: path, error: "checksum sidecar is not a regular file; backup left whole" },
      };
    }
    return { entry, sidecar: { path, bytes: st.size }, problem: null };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { entry, sidecar: null, problem: null };
    }
    return { entry, sidecar: null, problem: { file: path, error: errorMessage(err) } };
  }
}

const candidateOf = ({ entry, sidecar }: Item): PruneCandidate => ({
  name: entry.name,
  path: entry.path,
  bytes: entry.bytes + (sidecar?.bytes ?? 0),
  createdAt: entry.createdAt,
  label: entry.label,
  checksum: sidecar !== null,
});

/** Removes one backup. Returns the bytes actually freed; failures go to `errors`. */
function removeBackup(
  item: Item,
  ops: PruneOps,
  errors: PruneFailure[],
): { freed: number; complete: boolean } {
  try {
    ops.remove(item.entry.path);
  } catch (err) {
    errors.push({ file: item.entry.path, error: errorMessage(err) });
    return { freed: 0, complete: false };
  }
  if (!item.sidecar) return { freed: item.entry.bytes, complete: true };
  try {
    ops.remove(item.sidecar.path);
  } catch (err) {
    errors.push({ file: item.sidecar.path, error: errorMessage(err) });
    return { freed: item.entry.bytes, complete: false };
  }
  return { freed: item.entry.bytes + item.sidecar.bytes, complete: true };
}

const realOps: PruneOps = { remove: unlinkSync };

function rulesOf(ctx: Context): PruneRules {
  const { keep, olderThanDays } = ctx.opts;
  if (keep === undefined && olderThanDays === undefined) {
    throw new UsageError("backup prune needs --keep <N> and/or --older-than <days>");
  }
  return { keep, olderThanDays };
}

/** Plan the prune and, with --yes, carry it out. A dry run touches nothing. */
export function prune(ctx: Context, ops: PruneOps = realOps): PruneReport {
  const rules = rulesOf(ctx);
  assertNotRootOrHome(ctx);
  const dryRun = !ctx.opts.yes;
  const report: PruneReport = {
    dir: ctx.backupDir,
    dryRun,
    rules: { keep: rules.keep ?? null, olderThanDays: rules.olderThanDays ?? null },
    total: 0,
    kept: 0,
    ignored: 0,
    candidates: [],
    candidateBytes: 0,
    deleted: [],
    freedBytes: 0,
    errors: [],
  };
  // Never create the directory just to prune it.
  if (!existsSync(ctx.backupDir)) return report;
  ensureBackupDir(ctx.backupDir);

  const plan = planPrune(listBackups(ctx.backupDir), rules, ctx.deps.nowMs());
  const items = plan.doomed.map(inspect);
  const doable = items.filter((item) => item.problem === null);
  report.errors.push(...items.flatMap((item) => (item.problem ? [item.problem] : [])));
  report.ignored = plan.ignored;
  report.total = plan.kept.length + plan.doomed.length;
  report.candidates = doable.map(candidateOf);
  report.candidateBytes = report.candidates.reduce((sum, c) => sum + c.bytes, 0);
  report.kept = report.total - report.candidates.length;
  if (dryRun) return report;

  for (const item of doable) {
    const { freed, complete } = removeBackup(item, ops, report.errors);
    report.freedBytes += freed;
    if (complete) report.deleted.push(item.entry.name);
  }
  return report;
}
