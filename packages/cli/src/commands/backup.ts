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
