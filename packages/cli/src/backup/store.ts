import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { CliError, UsageError } from "../errors.js";

/**
 * The on-disk backup layout: one directory (0700) of
 *   klorn-<YYYYMMDDTHHMMSSZ>[-<label>].dump          pg_dump custom format, 0600
 *   klorn-<YYYYMMDDTHHMMSSZ>[-<label>].dump.sha256   `sha256sum -c` compatible
 * Dumps are real user data (mail metadata, encrypted OAuth tokens), so the
 * directory and every file are private to the owner.
 */

export const BACKUP_FILE = /^klorn-(\d{8}T\d{6}Z)(?:-([a-z0-9][a-z0-9.-]*))?\.dump$/;
export const LABEL = /^[a-z0-9][a-z0-9.-]{0,47}$/;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface BackupEntry {
  name: string;
  path: string;
  bytes: number;
  /** ISO-8601 UTC, from the file name. */
  createdAt: string;
  label: string | null;
  checksum: boolean;
}

export function backupFileName(date: Date, label?: string): string {
  if (label !== undefined && !LABEL.test(label)) {
    throw new UsageError("--label must be lowercase letters, digits, '.' or '-' (max 48)");
  }
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return `klorn-${stamp}${label ? `-${label}` : ""}.dump`;
}

/**
 * Create the backup directory 0700, or vet an existing one: it must be a
 * directory (a symlink to one is fine) owned by this user and writable by
 * nobody else — otherwise another local user could plant or swap dumps.
 * Readable-by-others is reported, not refused.
 */
export function ensureBackupDir(dir: string): { loosePermissions: boolean } {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    return { loosePermissions: false };
  }
  const st = statSync(dir);
  if (!st.isDirectory()) throw new CliError(`backup dir ${dir} is not a directory`);
  const euid = process.geteuid?.();
  if (euid !== undefined && st.uid !== euid) {
    throw new CliError(
      `backup dir ${dir} is owned by another user (uid ${st.uid}); refusing to use it`,
    );
  }
  if ((st.mode & 0o022) !== 0) {
    throw new CliError(`backup dir ${dir} is writable by other users; chmod 700 it first`);
  }
  return { loosePermissions: (st.mode & 0o077) !== 0 };
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolvePromise(hash.digest("hex")));
  });
}

export const checksumPath = (path: string) => `${path}.sha256`;

export function writeChecksum(path: string, hex: string): void {
  // "wx": never follow or overwrite something already sitting at this name.
  writeFileSync(checksumPath(path), `${hex}  ${basename(path)}\n`, {
    mode: PRIVATE_FILE_MODE,
    flag: "wx",
  });
}

export async function verifyChecksum(path: string): Promise<"ok" | "missing" | "mismatch"> {
  const sidecar = checksumPath(path);
  if (!existsSync(sidecar)) return "missing";
  const expected = readFileSync(sidecar, "utf8").trim().split(/\s+/)[0];
  return expected === (await sha256File(path)) ? "ok" : "mismatch";
}

const stampToIso = (stamp: string) =>
  `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;

export function listBackups(dir: string): BackupEntry[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((name) => {
      const match = BACKUP_FILE.exec(name);
      if (!match?.[1]) return [];
      const path = join(dir, name);
      const st = lstatSync(path);
      if (!st.isFile()) return [];
      return [
        {
          name,
          path,
          bytes: st.size,
          createdAt: stampToIso(match[1]),
          label: match[2] ?? null,
          checksum: existsSync(checksumPath(path)),
        },
      ];
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** A bare file name means "in the backup directory"; anything with a slash is a path. */
export function resolveBackupPath(input: string, dir: string, cwd: string): string {
  if (input.includes("/")) return isAbsolute(input) ? input : resolve(cwd, input);
  return join(dir, input);
}
