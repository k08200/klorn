import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";

/** Parse an env file (the format `docker compose --env-file` reads). */
export function readEnvFile(path: string): Record<string, string> {
  const parsed = parseEnv(readFileSync(path, "utf8"));
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

const KEY = /^[A-Z_][A-Z0-9_]*$/;
const SAFE_VALUE = /^[A-Za-z0-9._-]+$/;

/**
 * Set KEY=value in an env file: replace active `KEY=` lines in place, or
 * append one. Every other byte stays as it was. Written to a sibling temp
 * file with the original mode, then renamed, so a crash never leaves a
 * half-written secrets file. Only plain values are accepted — nothing that
 * could smuggle in a second line.
 */
export function upsertEnvVar(path: string, key: string, value: string): void {
  if (!KEY.test(key)) throw new Error(`invalid env key: ${key}`);
  if (!SAFE_VALUE.test(value)) throw new Error(`refusing to write an unsafe value for ${key}`);
  const original = readFileSync(path, "utf8");
  const assignment = new RegExp(`^(\\s*(?:export\\s+)?)${key}\\s*=.*$`, "gm");
  let updated: string;
  if (assignment.test(original)) {
    updated = original.replace(assignment, `$1${key}=${value}`);
  } else {
    const separator = original === "" || original.endsWith("\n") ? "" : "\n";
    updated = `${original}${separator}${key}=${value}\n`;
  }
  // Rewrite the real file when .env.selfhost is a symlink, not the link itself.
  const real = realpathSync(path);
  const mode = statSync(real).mode & 0o777;
  const temp = join(dirname(real), `.${key.toLowerCase()}.${randomBytes(6).toString("hex")}.tmp`);
  // "wx": never follow or reuse something already at the temp name.
  const fd = openSync(temp, "wx", mode);
  try {
    writeFileSync(fd, updated);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, real);
}
