import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "../context.js";
import { isUpToDate, migrationStatus } from "../db/migrations.js";
import { majorVersion, type PgTools } from "../db/pg.js";
import type { DbTarget, UrlTarget } from "../db/target.js";
import { errorMessage } from "../errors.js";
import { formatBytes } from "../lib/format.js";
import { describeHealth, fetchHealth, type HealthReading } from "../lib/health.js";
import { type Check, check } from "./types.js";

const CLOCK_SKEW_WARN_MS = 30_000;
const WEB_TIMEOUT_MS = 5_000;

const MAX_DETAIL_CHARS = 300;
/** Multi-line tool errors folded onto one doctor line. */
const firstLine = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" | ")
    .slice(0, MAX_DETAIL_CHARS);

export async function dockerCheck(ctx: Context): Promise<Check> {
  const result = await ctx.deps.runner({ cmd: "docker", args: ["compose", "version", "--short"] });
  if (result.code !== 0) {
    return check("docker", "fail", `docker compose unavailable: ${firstLine(result.stderr)}`);
  }
  return check("docker", "pass", `docker compose ${result.stdout.trim()}`);
}

export function composeFileCheck(ctx: Context): Check {
  const { composeFile } = ctx.compose;
  return existsSync(composeFile)
    ? check("compose.file", "pass", composeFile)
    : check("compose.file", "fail", `missing ${composeFile}`);
}

export async function postgresCheck(
  pg: PgTools,
  target: DbTarget,
): Promise<{ check: Check; serverVersion: string | null }> {
  try {
    const version = (await pg.query("show server_version")).split(" ")[0] ?? "";
    return {
      check: check("postgres", "pass", `reachable at ${target.label} (PostgreSQL ${version})`),
      serverVersion: version,
    };
  } catch (err) {
    return { check: check("postgres", "fail", firstLine(errorMessage(err))), serverVersion: null };
  }
}

export async function pgDumpCheck(
  pg: PgTools,
  target: DbTarget,
  serverVersion: string | null,
): Promise<Check> {
  const client = await pg.clientVersion();
  const where = target.kind === "compose" ? "in the postgres container" : "on this host";
  if (!client) {
    return check(
      "pg_dump",
      "warn",
      `pg_dump not found ${where} — backups need it (install postgresql-client)`,
    );
  }
  const clientMajor = majorVersion(client);
  const serverMajor = serverVersion ? majorVersion(serverVersion) : null;
  if (clientMajor !== null && serverMajor !== null && clientMajor < serverMajor) {
    return check(
      "pg_dump",
      "fail",
      `pg_dump ${client} ${where} cannot dump a PostgreSQL ${serverMajor} server`,
    );
  }
  return check("pg_dump", "pass", `pg_dump ${client} ${where}`);
}

export async function migrationsCheck(ctx: Context, pg: PgTools, target: DbTarget): Promise<Check> {
  try {
    const status = await migrationStatus(pg, ctx.migrations(target));
    if (status.failed.length > 0) {
      return check(
        "migrations",
        "fail",
        `failed: ${status.failed.join(", ")} — see klorn migrate status`,
      );
    }
    if (isUpToDate(status))
      return check("migrations", "pass", `${status.applied.length} applied, up to date`);
    const parts = [
      status.pending.length > 0
        ? `${status.pending.length} pending (next ${status.pending[0]})`
        : null,
      status.unknown.length > 0
        ? `${status.unknown.length} applied but unknown to this code`
        : null,
    ].filter(Boolean);
    return check("migrations", "warn", parts.join("; "));
  } catch (err) {
    return check("migrations", "fail", firstLine(errorMessage(err)));
  }
}

function nearestExisting(path: string): string {
  let current = path;
  while (!existsSync(current) && dirname(current) !== current) current = dirname(current);
  return current;
}

export async function diskCheck(ctx: Context, pg: PgTools | null): Promise<Check> {
  try {
    const at = nearestExisting(ctx.backupDir);
    const stats = await statfs(at);
    const free = stats.bavail * stats.bsize;
    const sizeText = pg ? await pg.query("select pg_database_size(current_database())") : "";
    const dbBytes = Number(sizeText) || null;
    const detail = `${formatBytes(free)} free for ${ctx.backupDir}${dbBytes ? ` (database ${formatBytes(dbBytes)})` : ""}`;
    return check("disk", dbBytes !== null && free < dbBytes ? "warn" : "pass", detail);
  } catch (err) {
    return check("disk", "warn", `could not measure free space: ${firstLine(errorMessage(err))}`);
  }
}

export async function apiCheck(
  ctx: Context,
): Promise<{ check: Check; reading: HealthReading | null }> {
  try {
    const reading = await fetchHealth(ctx.deps.fetch, ctx.apiUrl, ctx.deps.nowMs);
    const ok = reading.health.status === "ok";
    return {
      check: check(
        "api",
        ok ? "pass" : "fail",
        `${describeHealth(reading.health)} at ${ctx.apiUrl}`,
      ),
      reading,
    };
  } catch (err) {
    return { check: check("api", "fail", errorMessage(err)), reading: null };
  }
}

export function clockCheck(reading: HealthReading | null): Check {
  if (!reading) return check("clock", "skip", "needs the API");
  const server = Date.parse(reading.health.timestamp);
  const local = (reading.sentAtMs + reading.receivedAtMs) / 2;
  const skewSec = Math.round((server - local) / 1000);
  if (Math.abs(server - local) > CLOCK_SKEW_WARN_MS) {
    return check(
      "clock",
      "warn",
      `API clock is ${skewSec}s off this host's — OAuth and JWT expiry depend on it`,
    );
  }
  return check("clock", "pass", `API clock within ${Math.abs(skewSec)}s of this host`);
}

export async function webCheck(ctx: Context): Promise<Check> {
  try {
    const response = await ctx.deps.fetch(ctx.webUrl, {
      signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
    });
    return response.ok
      ? check("web", "pass", `HTTP ${response.status} at ${ctx.webUrl}`)
      : check("web", "fail", `HTTP ${response.status} at ${ctx.webUrl}`);
  } catch (err) {
    return check("web", "fail", `unreachable at ${ctx.webUrl} (${errorMessage(err)})`);
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const SAFE_SSLMODES = new Set(["require", "verify-ca", "verify-full"]);

/** A remote Postgres without sslmode=require can be downgraded to cleartext (libpq defaults to prefer). */
export function tlsCheck(target: UrlTarget): Check {
  const { host, sslmode } = target.conn;
  if (LOCAL_HOSTS.has(host)) return check("postgres.tls", "pass", "local host");
  if (sslmode && SAFE_SSLMODES.has(sslmode))
    return check("postgres.tls", "pass", `sslmode=${sslmode}`);
  return check(
    "postgres.tls",
    "warn",
    `remote host without sslmode=require (${sslmode ?? "unset"}) — add ?sslmode=require to the URL`,
  );
}
