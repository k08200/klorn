import { existsSync } from "node:fs";
import { basename } from "node:path";
import { ensureBackupDir, resolveBackupPath, verifyChecksum } from "../backup/store.js";
import { type TakenBackup, takeBackup } from "../backup/take.js";
import type { Context } from "../context.js";
import { type DbTarget, HOSTED_PROD_REF, looksLikeHostedProd } from "../db/target.js";
import { CliError, errorMessage, UsageError } from "../errors.js";
import { onInterrupt } from "../lib/cleanup.js";
import { composeSpec } from "../lib/compose.js";
import { confirmTyped } from "../lib/confirm.js";
import { describeHealth, pollHealth } from "../lib/health.js";

const API_RESTART_TIMEOUT_SEC = 180;

/** Shared with migrate deploy: refuse Klorn's hosted production unless --i-know. */
export function assertNotHostedProd(ctx: Context, target: DbTarget): void {
  if (looksLikeHostedProd(target) && !ctx.opts.iKnow) {
    throw new CliError(
      `refusing: ${target.label} looks like Klorn's hosted production database (${HOSTED_PROD_REF}). ` +
        "Pass --i-know only if you really mean to change it.",
    );
  }
}

function resolveRestoreTarget(ctx: Context): DbTarget {
  if (!ctx.opts.target) {
    throw new UsageError("restore needs an explicit --target (compose, env:VAR or a postgres URL)");
  }
  const target = ctx.parseTarget(ctx.opts.target);
  assertNotHostedProd(ctx, target);
  return target;
}

async function assertChecksum(file: string): Promise<void> {
  const sum = await verifyChecksum(file);
  if (sum === "mismatch") {
    throw new CliError(
      `checksum mismatch for ${file} — it changed since it was taken; refusing to restore it`,
    );
  }
  if (sum === "missing") {
    throw new CliError(
      `${basename(file)} has no .sha256 next to it, so it cannot be verified. If you trust it, ` +
        `create one: (cd "$(dirname '${file}')" && sha256sum '${basename(file)}' > '${basename(file)}.sha256')`,
    );
  }
}

async function composeApi(ctx: Context, args: string[]): Promise<void> {
  const result = await ctx.deps.runner(composeSpec(ctx.compose, args));
  if (result.code !== 0) {
    throw new CliError(`docker compose ${args.join(" ")} failed:\n${result.stderr.trim()}`);
  }
}

/** Stop the api when it is running — or crash-looping, which would race the restore. */
async function stopApiIfActive(ctx: Context): Promise<boolean> {
  const ps = await ctx.deps.runner(
    composeSpec(ctx.compose, ["ps", "--status", "running", "--status", "restarting", "-q", "api"]),
  );
  if (ps.code !== 0) throw new CliError(`docker compose ps failed:\n${ps.stderr.trim()}`);
  if (ps.stdout.trim() === "") return false;
  ctx.deps.io.err("stopping api for the restore");
  await composeApi(ctx, ["stop", "api"]);
  return true;
}

/** `up -d --no-deps api`, not `start`: it applies the pinned image (KLORN_VERSION). */
async function startApi(ctx: Context): Promise<string | null> {
  ctx.deps.io.err("starting api");
  try {
    await composeApi(ctx, ["up", "-d", "--no-deps", "api"]);
    return null;
  } catch (err) {
    return errorMessage(err);
  }
}

/** The restarted api migrates on boot (start.sh); report only once it answers ok. */
async function waitForApi(ctx: Context): Promise<void> {
  try {
    const health = await pollHealth(ctx.deps, ctx.apiUrl, (h) => h.status === "ok", {
      timeoutMs: (ctx.opts.timeoutSec ?? API_RESTART_TIMEOUT_SEC) * 1000,
    });
    ctx.deps.io.out(`api is back: ${describeHealth(health)}`);
  } catch (err) {
    throw new CliError(
      `restored, but the api did not come back healthy (${errorMessage(err)}) — run \`pnpm klorn doctor\``,
    );
  }
}

async function snapshotAndRestore(
  ctx: Context,
  target: DbTarget,
  file: string,
): Promise<TakenBackup | null> {
  const snapshot = ctx.opts.noBackup ? null : await takeBackup(ctx, target, "pre-restore");
  // Re-verify right before use: the snapshot can take minutes, and the file
  // must still be the one that was checked and confirmed.
  await assertChecksum(file);
  await ctx.pg(target).restoreFrom(file, ctx.backupDir);
  return snapshot;
}

/**
 * Replace the target's public schema with a dump. Destructive, so: explicit
 * --target, the hosted-prod guard, a verified checksum, an archive
 * read-through, a typed confirmation (or --yes), writers stopped, then a
 * pre-restore snapshot (unless --no-backup), and one transaction for the
 * whole restore — any error leaves the target exactly as it was.
 */
export async function backupRestore(ctx: Context, fileArg: string | undefined): Promise<number> {
  if (!fileArg) throw new UsageError("usage: klorn backup restore <file> --target <db>");
  const target = resolveRestoreTarget(ctx);
  const file = resolveBackupPath(fileArg, ctx.backupDir, ctx.deps.cwd);
  if (!existsSync(file)) throw new CliError(`no such backup: ${file}`);
  await assertChecksum(file);
  const { io } = ctx.deps;
  ensureBackupDir(ctx.backupDir);
  await ctx.pg(target).listArchive(file);
  io.err(
    `restore ${basename(file)} into ${target.label}: replaces everything in its public schema`,
  );
  if (target.kind === "url") {
    io.err("stop every Klorn API process that writes to this database before you continue");
  }
  await confirmTyped(
    io,
    `type the database name (${target.database}) to confirm: `,
    target.database,
    ctx.opts.yes,
  );

  const stopped = target.kind === "compose" ? await stopApiIfActive(ctx) : false;
  const release = stopped
    ? onInterrupt(() =>
        process.stderr.write("klorn: interrupted — the api is stopped; run `pnpm klorn up`\n"),
      )
    : () => {};
  let snapshot: TakenBackup | null = null;
  let restoreError: unknown = null;
  try {
    snapshot = await snapshotAndRestore(ctx, target, file);
  } catch (err) {
    restoreError = err;
  }
  const startError = stopped ? await startApi(ctx) : null;
  release();
  if (restoreError) {
    if (startError)
      io.err(`also: the api did not start again (${startError}) — run \`pnpm klorn up\``);
    throw restoreError;
  }
  if (startError)
    throw new CliError(
      `restored, but the api did not start again (${startError}) — run \`pnpm klorn up\``,
    );
  io.out(`restored ${file} into ${target.label}`);
  if (snapshot) io.out(`pre-restore backup: ${snapshot.path}`);
  if (stopped) await waitForApi(ctx);
  return 0;
}
