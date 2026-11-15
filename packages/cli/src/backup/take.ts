import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../context.js";
import type { DbTarget } from "../db/target.js";
import { CliError } from "../errors.js";
import { onInterrupt } from "../lib/cleanup.js";
import {
  type BackupEntry,
  backupFileName,
  checksumPath,
  ensureBackupDir,
  listBackups,
  sha256File,
  writeChecksum,
} from "./store.js";

export interface TakenBackup extends BackupEntry {
  sha256: string;
}

/**
 * pg_dump the target into the backup directory: write `<name>.partial`,
 * checksum it, write the sidecar, then rename the dump into place — a crash,
 * a failed dump or an interrupt never leaves a file that looks like a good
 * backup.
 */
export async function takeBackup(
  ctx: Context,
  target: DbTarget,
  label?: string,
): Promise<TakenBackup> {
  const { io } = ctx.deps;
  const name = backupFileName(new Date(ctx.deps.nowMs()), label);
  if (ensureBackupDir(ctx.backupDir).loosePermissions) {
    io.err(
      `warn: ${ctx.backupDir} is readable by other users; dumps hold user data — chmod 700 it`,
    );
  }
  const path = join(ctx.backupDir, name);
  const partial = `${path}.partial`;
  for (const existing of [path, checksumPath(path), partial]) {
    if (existsSync(existing)) {
      throw new CliError(
        `${existing} already exists (a backup running now, or one an interrupt left behind — remove it if none is running)`,
      );
    }
  }
  const cleanup = () => {
    rmSync(partial, { force: true });
    if (!existsSync(path)) rmSync(checksumPath(path), { force: true });
  };
  const release = onInterrupt(cleanup);
  io.err(`backing up ${target.label} -> ${path}`);
  try {
    await ctx.pg(target).dumpTo(partial);
    if (statSync(partial).size === 0) throw new CliError("pg_dump produced an empty archive");
    const sha256 = await sha256File(partial);
    writeChecksum(path, sha256);
    renameSync(partial, path);
    const entry = listBackups(ctx.backupDir).find((e) => e.path === path);
    if (!entry) throw new CliError(`backup written but not listed: ${path}`);
    return { ...entry, sha256 };
  } catch (err) {
    cleanup();
    throw err;
  } finally {
    release();
  }
}
