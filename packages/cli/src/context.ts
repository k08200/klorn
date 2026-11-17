import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { composeMigrations, localMigrations, type MigrationSource } from "./db/migrations.js";
import { createPgTools, type PgTools } from "./db/pg.js";
import { type DbTarget, parseDbSpec } from "./db/target.js";
import { UsageError } from "./errors.js";
import type { ComposeRef } from "./lib/compose.js";
import { readEnvFile } from "./lib/env-file.js";
import { type Runner, spawnRunner } from "./lib/exec.js";

export interface Io {
  /** Results (stdout). */
  out(line: string): void;
  /** Progress, warnings, errors (stderr) — keeps --json output clean. */
  err(line: string): void;
  /** True when a human can answer a prompt (stdin is a TTY). */
  interactive: boolean;
  ask(question: string): Promise<string>;
}

export interface Deps {
  runner: Runner;
  fetch: typeof fetch;
  io: Io;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The shell environment (process.env). */
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
  /** Where relative paths given by the user resolve from. */
  cwd: string;
  /** The checkout this CLI runs from (docker-compose.selfhost.yml lives here). */
  repoRoot: string;
}

export interface Options {
  json: boolean;
  yes: boolean;
  noBackup: boolean;
  iKnow: boolean;
  allowDowngrade: boolean;
  db?: string;
  target?: string;
  label?: string;
  composeFile?: string;
  envFile?: string;
  backupDir?: string;
  apiUrl?: string;
  webUrl?: string;
  timeoutSec?: number;
  /** backup prune: keep this many of the newest backups. */
  keep?: number;
  /** backup prune: delete only backups older than this many days. */
  olderThanDays?: number;
}

export interface EnvFileState {
  path: string;
  explicit: boolean;
  exists: boolean;
  values: Readonly<Record<string, string>>;
}

export interface Context {
  deps: Deps;
  opts: Options;
  compose: ComposeRef;
  envFile: EnvFileState;
  backupDir: string;
  apiUrl: string;
  webUrl: string;
  /** Shell env first, then the env file — the precedence docker compose uses. */
  lookup(name: string): string | undefined;
  /** Merged view of the env file and the shell, for configuration checks. */
  mergedEnv(): Record<string, string | undefined>;
  /** The `--db` target (default: compose). */
  db(): DbTarget;
  parseTarget(spec: string): DbTarget;
  pg(target: DbTarget): PgTools;
  migrations(target: DbTarget, version?: string): MigrationSource;
}

const DEFAULT_COMPOSE_FILE = "docker-compose.selfhost.yml";
const DEFAULT_ENV_FILE = ".env.selfhost";
const DEFAULT_BACKUP_DIR = "klorn-backups";
const DEFAULT_API_URL = "http://localhost:3001";
const DEFAULT_WEB_URL = "http://localhost:3000";

function httpUrl(value: string, flag: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`${flag} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`${flag} must be an http(s) URL`);
  }
  return url.href;
}

export function buildContext(deps: Deps, opts: Options): Context {
  const fromCwd = (p: string) => (isAbsolute(p) ? p : resolve(deps.cwd, p));
  const envPath = opts.envFile ? fromCwd(opts.envFile) : join(deps.repoRoot, DEFAULT_ENV_FILE);
  const envExists = existsSync(envPath);
  const envFile: EnvFileState = {
    path: envPath,
    explicit: opts.envFile !== undefined,
    exists: envExists,
    values: envExists ? readEnvFile(envPath) : {},
  };
  const lookup = (name: string) => deps.env[name] || envFile.values[name] || undefined;
  const compose: ComposeRef = {
    composeFile: opts.composeFile
      ? fromCwd(opts.composeFile)
      : join(deps.repoRoot, DEFAULT_COMPOSE_FILE),
    envFile: envPath,
  };
  const backupDirRaw = opts.backupDir ?? deps.env.KLORN_BACKUP_DIR;
  const backupDir = backupDirRaw ? fromCwd(backupDirRaw) : join(deps.homeDir, DEFAULT_BACKUP_DIR);
  const apiUrl = httpUrl(
    opts.apiUrl || deps.env.KLORN_API_URL || envFile.values.NEXT_PUBLIC_API_URL || DEFAULT_API_URL,
    "--api-url",
  );
  const webUrl = httpUrl(
    opts.webUrl || deps.env.KLORN_WEB_URL || envFile.values.WEB_URL || DEFAULT_WEB_URL,
    "--web-url",
  );
  const parseTarget = (spec: string) => parseDbSpec(spec, lookup);
  return {
    deps,
    opts,
    compose,
    envFile,
    backupDir,
    apiUrl,
    webUrl,
    lookup,
    mergedEnv: () => ({ ...envFile.values, ...pickSet(deps.env) }),
    db: () => parseTarget(opts.db ?? "compose"),
    parseTarget,
    pg: (target) => createPgTools(target, deps.runner, compose),
    migrations: (target, version) =>
      target.kind === "compose"
        ? composeMigrations(compose, deps.runner, version)
        : localMigrations(deps.repoRoot, target, deps.runner, deps.env),
  };
}

/** Shell values that are actually set (compose treats empty as unset for `:-`/`:?`). */
function pickSet(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

// Control characters other than newline and tab: tool output, database rows
// and API answers reach the terminal through io, and must not drive it.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
export const sanitize = (text: string) => text.replace(CONTROL_CHARS, "?");

/**
 * Where relative paths given by the user resolve from. pnpm runs the root
 * `klorn` script from the repository root and records the caller's directory
 * in INIT_CWD — trusted only inside such a script run, never left over from
 * an unrelated parent process.
 */
function userCwd(): string {
  return process.env.npm_lifecycle_event && process.env.INIT_CWD
    ? process.env.INIT_CWD
    : process.cwd();
}

export function realDeps(repoRoot: string): Deps {
  const io: Io = {
    out: (line) => process.stdout.write(`${sanitize(line)}\n`),
    err: (line) => process.stderr.write(`${sanitize(line)}\n`),
    interactive: process.stdin.isTTY === true,
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
  return {
    runner: spawnRunner,
    fetch: globalThis.fetch,
    io,
    nowMs: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    env: process.env,
    homeDir: homedir(),
    cwd: userCwd(),
    repoRoot,
  };
}
