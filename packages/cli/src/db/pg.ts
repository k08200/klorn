import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { CliError } from "../errors.js";
import { onInterrupt } from "../lib/cleanup.js";
import { type ComposeRef, composeSpec } from "../lib/compose.js";
import { type CommandSpec, type Runner, type RunOptions, redact, tail } from "../lib/exec.js";
import type { DbTarget, UrlTarget } from "./target.js";

/**
 * pg_dump / pg_restore / psql against a target, without a credential in argv.
 *
 *   compose: `docker compose exec -T postgres <tool>` — the postgres image
 *            trusts its own local socket, so nothing secret is involved.
 *   url:     the host's client tools; host/port/user in PG* env vars and the
 *            password in a temporary 0600 PGPASSFILE removed after each call.
 *
 * Archives always travel through stdout/stdin, so the same code path works
 * whether the tool runs on this host or inside a container.
 */

// Public schema plus pg_trgm (schema.prisma `extensions = [pg_trgm]`): the
// same selection the hosted backup workflow takes (.github/workflows/db-backup.yml),
// so a dump also restores into a managed Postgres that carries extra schemas.
export const DUMP_ARGS = [
  "--format=custom",
  "--schema=public",
  "--extension=pg_trgm",
  "--no-owner",
  "--no-privileges",
] as const;

// Restore = the archive rendered as a SQL script, applied by psql as ONE
// transaction that starts by dropping the whole public schema. `pg_restore
// --clean` alone is not enough: it only drops what the dump knows, so tables
// a newer migration added survive and block the restore (rolling back after
// an upgrade is exactly that case). In one transaction, any error leaves the
// target exactly as it was. Verified against Postgres 16: over a populated
// database, over one with objects newer than the dump, into an empty one, and
// with a failing script (rolled back).
export const RESTORE_SCRIPT_ARGS = ["--file=-", "--no-owner", "--no-privileges"] as const;
export const RESTORE_APPLY_ARGS = [
  "-X",
  "-q",
  "-v",
  "ON_ERROR_STOP=1",
  "--single-transaction",
  "-c",
  "DROP SCHEMA IF EXISTS public CASCADE",
  "-f",
  "-",
] as const;

const PSQL_ARGS = ["-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1"] as const;
const ERROR_TAIL_LINES = 6;
// Inherited libpq variables that could route a connection somewhere other than
// the host/port in the URL — the label, the prod guard and the confirmation
// prompt would then describe a different database than the one touched.
const ROUTING_ENV = ["PGSERVICE", "PGSERVICEFILE", "PGHOSTADDR", "PGSYSCONFDIR"] as const;

type Tool = "psql" | "pg_dump" | "pg_restore";

export interface PgTools {
  /** Run one constant SQL statement; returns unaligned, tuples-only output. */
  query(sql: string): Promise<string>;
  dumpTo(path: string): Promise<void>;
  /** Replace the public schema with the archive. `workDir` holds the transient SQL script. */
  restoreFrom(archive: string, workDir: string): Promise<void>;
  /** pg_restore --list of an archive; proves it is a readable custom-format dump. */
  listArchive(path: string): Promise<string>;
  /** The pg_dump version that would take a backup, or null when it is missing. */
  clientVersion(): Promise<string | null>;
}

export function escapePgpass(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

interface Prepared {
  spec: CommandSpec;
  cleanup: () => void;
}

function passfile(password: string): { env: Record<string, string>; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "klorn-pgpass-"));
  const remove = () => rmSync(dir, { recursive: true, force: true });
  const release = onInterrupt(remove);
  const file = join(dir, "pgpass");
  writeFileSync(file, `*:*:*:*:${escapePgpass(password)}\n`, { mode: 0o600 });
  return {
    // An inherited PGPASSWORD would outrank the file; blank it.
    env: { PGPASSFILE: file, PGPASSWORD: "" },
    cleanup: () => {
      remove();
      release();
    },
  };
}

function prepareUrl(
  target: UrlTarget,
  tool: Tool,
  args: readonly string[],
  connect: boolean,
): Prepared {
  const { conn } = target;
  const env: Record<string, string> = {
    PGHOST: conn.host,
    PGPORT: conn.port,
    // Always explicit: an inherited PGUSER must not pick the role.
    PGUSER: conn.user || userInfo().username,
    PGAPPNAME: "klorn-cli",
  };
  if (conn.sslmode) env.PGSSLMODE = conn.sslmode;
  if (conn.sslrootcert) env.PGSSLROOTCERT = conn.sslrootcert;
  if (conn.connectTimeout) env.PGCONNECT_TIMEOUT = conn.connectTimeout;
  const pass = connect && conn.password !== null ? passfile(conn.password) : null;
  const connectArgs = connect ? [`--dbname=${conn.database}`] : [];
  return {
    spec: {
      cmd: tool,
      args: [...connectArgs, ...args],
      env: { ...env, ...pass?.env },
      unsetEnv: ROUTING_ENV,
    },
    cleanup: pass?.cleanup ?? (() => {}),
  };
}

export function createPgTools(target: DbTarget, runner: Runner, compose: ComposeRef): PgTools {
  const secrets = target.kind === "url" ? [target.conn.password] : [];

  const prepare = (tool: Tool, args: readonly string[], connect = true): Prepared => {
    if (target.kind === "url") return prepareUrl(target, tool, args, connect);
    const connectArgs = connect ? [`--username=${target.user}`, `--dbname=${target.database}`] : [];
    return {
      spec: composeSpec(compose, ["exec", "-T", "postgres", tool, ...connectArgs, ...args]),
      cleanup: () => {},
    };
  };

  const run = async (
    tool: Tool,
    args: readonly string[],
    opts?: RunOptions,
    connect = true,
  ): Promise<string> => {
    const { spec, cleanup } = prepare(tool, args, connect);
    try {
      const result = await runner(spec, opts);
      if (result.code !== 0) {
        const detail = redact(tail(result.stderr, ERROR_TAIL_LINES), secrets);
        throw new CliError(`${tool} failed (exit ${result.code}) on ${target.label}:\n${detail}`);
      }
      return result.stdout;
    } finally {
      cleanup();
    }
  };

  const restoreFrom = async (archive: string, workDir: string): Promise<void> => {
    const script = join(workDir, `.restore-${randomBytes(6).toString("hex")}.sql`);
    const remove = () => rmSync(script, { force: true });
    const release = onInterrupt(remove);
    try {
      await run(
        "pg_restore",
        RESTORE_SCRIPT_ARGS,
        { stdinFile: archive, stdoutFile: script },
        false,
      );
      await run("psql", RESTORE_APPLY_ARGS, { stdinFile: script });
    } finally {
      remove();
      release();
    }
  };

  return {
    query: async (sql) => (await run("psql", [...PSQL_ARGS, "-c", sql])).trim(),
    dumpTo: async (path) => {
      await run("pg_dump", DUMP_ARGS, { stdoutFile: path });
    },
    restoreFrom,
    listArchive: (path) => run("pg_restore", ["--list"], { stdinFile: path }, false),
    clientVersion: async () => {
      const { spec, cleanup } = prepare("pg_dump", ["--version"], false);
      try {
        const result = await runner(spec);
        if (result.code !== 0) return null;
        return /PostgreSQL\)\s+(\d+(?:\.\d+)?)/.exec(result.stdout)?.[1] ?? null;
      } finally {
        cleanup();
      }
    },
  };
}

/** Major version from `show server_version` / `pg_dump --version` output ("16.4 (Debian…)"). */
export function majorVersion(version: string): number | null {
  const match = /^(\d+)/.exec(version.trim());
  return match ? Number(match[1]) : null;
}
