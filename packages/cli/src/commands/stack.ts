import { existsSync } from "node:fs";
import { takeBackup } from "../backup/take.js";
import { checkEnv } from "../checks/env-checks.js";
import type { Context } from "../context.js";
import { composeMigrations } from "../db/migrations.js";
import { CliError, errorMessage, UsageError } from "../errors.js";
import { composeSpec } from "../lib/compose.js";
import { confirmYesNo } from "../lib/confirm.js";
import { upsertEnvVar } from "../lib/env-file.js";
import { describeHealth, fetchHealth, type Health, pollHealth } from "../lib/health.js";

/**
 * `klorn up` and `klorn upgrade` — the self-host "deploy": the official
 * docker-compose.selfhost.yml, its published ghcr images, and the
 * KLORN_VERSION pin that compose interpolates into both image tags.
 */

const VERSION = /^v?(\d+\.\d+\.\d+|\d+\.\d+|latest)$/;
const UP_TIMEOUT_SEC = 180;
const UPGRADE_TIMEOUT_SEC = 300;
// The recreated api must report an uptime no older than the recreate itself
// (plus slack for the container start), so an old process can never pass.
const UPTIME_SLACK_SEC = 15;

export interface ImageVersion {
  /** The image tag (no leading v): 0.4.1, 0.4 or latest. */
  tag: string;
  /** Only an X.Y.Z tag names the version /api/health will report. */
  exact: boolean;
}

export function parseVersion(raw: string): ImageVersion {
  const match = VERSION.exec(raw);
  if (!match?.[1]) {
    throw new UsageError(`"${raw}" is not a version (use X.Y.Z, X.Y or latest, e.g. 0.4.1)`);
  }
  return { tag: match[1], exact: /^\d+\.\d+\.\d+$/.test(match[1]) };
}

const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * True when `requested` moves the stack backwards from `running`. An X.Y tag
 * compares major.minor; `latest` never counts. A running version that is not
 * X.Y.Z (a prerelease, a dev build) cannot be compared, so it never blocks.
 */
export function isDowngrade(requested: ImageVersion, running: string | null): boolean {
  if (!running || !SEMVER.test(running) || requested.tag === "latest") return false;
  const want = requested.tag.split(".").map(Number);
  const have = running.split(".").map(Number);
  for (let i = 0; i < want.length; i += 1) {
    const diff = (want[i] ?? 0) - (have[i] ?? 0);
    if (diff !== 0) return diff < 0;
  }
  return false;
}

// Missing an LLM provider leaves mail unjudged, but the API and compose still
// start; doctor reports it, up/upgrade only warn.
const BOOT_OPTIONAL_CHECKS = new Set(["env.llm_provider"]);

function preflight(ctx: Context): void {
  if (ctx.db().kind !== "compose") {
    throw new UsageError("up/upgrade manage the docker compose stack; they do not take --db");
  }
  if (!existsSync(ctx.compose.composeFile)) {
    throw new CliError(`missing ${ctx.compose.composeFile}`);
  }
  if (!ctx.envFile.exists) {
    throw new CliError(
      `missing ${ctx.envFile.path} — cp .env.selfhost.example .env.selfhost and fill it in`,
    );
  }
  const failures = checkEnv(ctx.mergedEnv(), "compose").filter((c) => c.status === "fail");
  for (const c of failures.filter((f) => BOOT_OPTIONAL_CHECKS.has(f.id))) {
    ctx.deps.io.err(`warn: ${c.id}: ${c.detail}`);
  }
  const blocking = failures.filter((c) => !BOOT_OPTIONAL_CHECKS.has(c.id));
  if (blocking.length > 0) {
    const lines = blocking.map((c) => `  ${c.id}: ${c.detail}`).join("\n");
    throw new CliError(
      `docker compose or the API would refuse to start — fix these first (pnpm klorn doctor shows every check):\n${lines}`,
    );
  }
}

async function compose(ctx: Context, args: string[], env?: Record<string, string>): Promise<void> {
  ctx.deps.io.err(`$ docker compose ${args.join(" ")}`);
  const result = await ctx.deps.runner(composeSpec(ctx.compose, args, env), { inherit: true });
  if (result.code !== 0) {
    throw new CliError(`docker compose ${args.join(" ")} failed (exit ${result.code})`);
  }
}

const timeoutMs = (ctx: Context, fallbackSec: number) =>
  (ctx.opts.timeoutSec ?? fallbackSec) * 1000;

export async function up(ctx: Context): Promise<number> {
  preflight(ctx);
  await compose(ctx, ["up", "-d"]);
  const health = await pollHealth(ctx.deps, ctx.apiUrl, (h) => h.status === "ok", {
    timeoutMs: timeoutMs(ctx, UP_TIMEOUT_SEC),
  });
  ctx.deps.io.out(`klorn is up: ${describeHealth(health)} at ${ctx.apiUrl}`);
  return 0;
}

async function currentVersion(ctx: Context): Promise<string | null> {
  try {
    return (await fetchHealth(ctx.deps.fetch, ctx.apiUrl, ctx.deps.nowMs)).health.version;
  } catch {
    ctx.deps.io.err(
      "warn: the API is not answering; upgrading without knowing the running version",
    );
    return null;
  }
}

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** Pin first, then restore: the restore restarts the api on whatever the pin says. */
function rollbackHint(ctx: Context, previousPin: string, backupPath: string | null): string {
  const pin = `  1. set KLORN_VERSION=${previousPin} in ${ctx.envFile.path}\n`;
  const restore = backupPath
    ? `  2. pnpm klorn backup restore ${shellQuote(backupPath)} --target compose\n`
    : "  2. pnpm klorn up  (no pre-upgrade backup was taken: --no-backup; the database keeps the newer migrations)\n";
  return `to roll back:\n${pin}${restore}`.trimEnd();
}

function assertNotDowngrade(ctx: Context, running: string | null, version: ImageVersion): void {
  if (running && !SEMVER.test(running)) {
    ctx.deps.io.err(
      `warn: running version "${running}" is not X.Y.Z; skipping the downgrade check`,
    );
  }
  if (ctx.opts.allowDowngrade || !isDowngrade(version, running)) return;
  throw new CliError(
    `${running} -> ${version.tag} is a downgrade; migrations only go forward. ` +
      "Restore a backup taken on the older version instead, or pass --allow-downgrade.",
  );
}

/** After a timeout: a fresh, healthy api on the wrong version is a tag mismatch, not an outage. */
async function versionMismatch(
  ctx: Context,
  version: ImageVersion,
  since: number,
): Promise<string | null> {
  if (!version.exact) return null;
  try {
    const { health } = await fetchHealth(ctx.deps.fetch, ctx.apiUrl, ctx.deps.nowMs);
    const fresh = health.uptime <= (ctx.deps.nowMs() - since) / 1000 + UPTIME_SLACK_SEC;
    if (health.status !== "ok" || !fresh || health.version === version.tag) return null;
    return (
      `the new api is up and healthy but reports version ${health.version ?? "unknown"}, not ${version.tag} — ` +
      "the image's package version and its tag disagree; check with `pnpm klorn doctor`"
    );
  } catch {
    return null;
  }
}

async function restartAndWait(
  ctx: Context,
  version: ImageVersion,
  env: Record<string, string>,
  hint: string,
): Promise<Health> {
  const recreatedAt = ctx.deps.nowMs();
  try {
    await compose(ctx, ["up", "-d", "--force-recreate", "api", "web"], env);
    return await pollHealth(
      ctx.deps,
      ctx.apiUrl,
      (h) =>
        h.status === "ok" &&
        (!version.exact || h.version === version.tag) &&
        h.uptime <= (ctx.deps.nowMs() - recreatedAt) / 1000 + UPTIME_SLACK_SEC,
      { timeoutMs: timeoutMs(ctx, UPGRADE_TIMEOUT_SEC) },
    );
  } catch (err) {
    const mismatch = await versionMismatch(ctx, version, recreatedAt);
    throw new CliError(mismatch ?? `${errorMessage(err)}\n${hint}`);
  }
}

function pinVersion(ctx: Context, tag: string, hint: string): void {
  try {
    upsertEnvVar(ctx.envFile.path, "KLORN_VERSION", tag);
  } catch (err) {
    throw new CliError(
      `migrated, but could not pin KLORN_VERSION in ${ctx.envFile.path} (${errorMessage(err)}); ` +
        `the running api was not replaced.\n${hint}`,
    );
  }
  ctx.deps.io.err(`pinned KLORN_VERSION=${tag} in ${ctx.envFile.path}`);
}

/**
 * Pull → back up → migrate with the NEW image (the old api keeps serving;
 * Klorn migrations are additive) → pin KLORN_VERSION → recreate api and web →
 * wait until /api/health reports the new process (and version, for X.Y.Z).
 */
export async function upgrade(ctx: Context, versionArg: string | undefined): Promise<number> {
  if (!versionArg) throw new UsageError("usage: klorn upgrade <version>  (e.g. 0.4.1, or latest)");
  const version = parseVersion(versionArg);
  preflight(ctx);
  const { io } = ctx.deps;
  const running = await currentVersion(ctx);
  assertNotDowngrade(ctx, running, version);
  const previousPin =
    ctx.envFile.values.KLORN_VERSION || (running && SEMVER.test(running) ? running : "latest");
  io.err(
    `upgrade ${running ?? "unknown"} -> ${version.tag}: pull, back up, migrate, restart api and web`,
  );
  await confirmYesNo(io, "continue?", ctx.opts.yes);

  const env = { KLORN_VERSION: version.tag };
  await compose(ctx, ["pull", "api", "web"], env);
  await compose(ctx, ["up", "-d", "--wait", "postgres"], env);
  const backup = ctx.opts.noBackup
    ? null
    : await takeBackup(ctx, ctx.db(), `pre-upgrade-${version.tag}`);
  const hint = rollbackHint(ctx, previousPin, backup?.path ?? null);
  try {
    await composeMigrations(ctx.compose, ctx.deps.runner, version.tag).deploy();
  } catch (err) {
    throw new CliError(`${errorMessage(err)}; the running api was not touched.\n${hint}`);
  }
  pinVersion(ctx, version.tag, hint);
  const health = await restartAndWait(ctx, version, env, hint);
  io.out(`upgraded to ${version.tag}: ${describeHealth(health)}`);
  if (backup) io.out(`pre-upgrade backup: ${backup.path}`);
  return 0;
}
