import { statSync } from "node:fs";
import { checkEnv } from "../checks/env-checks.js";
import {
  apiCheck,
  clockCheck,
  composeFileCheck,
  diskCheck,
  dockerCheck,
  migrationsCheck,
  pgDumpCheck,
  postgresCheck,
  tlsCheck,
  webCheck,
} from "../checks/runtime-checks.js";
import { type Check, type CheckStatus, check } from "../checks/types.js";
import type { Context } from "../context.js";

/**
 * `klorn doctor` — read-only. Every check reports pass / warn / fail / skip;
 * any fail makes the exit code 1. Nothing is written, started or migrated.
 */

function envChecks(ctx: Context, mode: "compose" | "url"): Check[] {
  const { envFile } = ctx;
  if (envFile.exists) {
    const loose = (statSync(envFile.path).mode & 0o077) !== 0;
    const fileCheck = loose
      ? check("env.file", "warn", `${envFile.path} is readable by other users — chmod 600 it`)
      : check("env.file", "pass", envFile.path);
    return [fileCheck, ...checkEnv(ctx.mergedEnv(), mode)];
  }
  if (mode === "compose" || envFile.explicit) {
    return [
      check(
        "env.file",
        "fail",
        `missing ${envFile.path} — cp .env.selfhost.example .env.selfhost and fill it in`,
      ),
    ];
  }
  return [
    check("env.file", "skip", "no env file — pass --env-file to check the API's configuration"),
  ];
}

export async function runDoctor(ctx: Context): Promise<Check[]> {
  const target = ctx.db();
  const checks: Check[] = [...envChecks(ctx, target.kind)];
  if (target.kind === "compose") {
    checks.push(await dockerCheck(ctx), composeFileCheck(ctx));
  }
  const pg = ctx.pg(target);
  const postgres = await postgresCheck(pg, target);
  checks.push(postgres.check);
  if (target.kind === "url") checks.push(tlsCheck(target));
  const pgUp = postgres.check.status === "pass";
  checks.push(
    pgUp
      ? await pgDumpCheck(pg, target, postgres.serverVersion)
      : check("pg_dump", "skip", "needs Postgres"),
    pgUp ? await migrationsCheck(ctx, pg, target) : check("migrations", "skip", "needs Postgres"),
    await diskCheck(ctx, pgUp ? pg : null),
  );
  const api = await apiCheck(ctx);
  checks.push(api.check, clockCheck(api.reading), await webCheck(ctx));
  return checks;
}

function summarize(checks: Check[]): Record<CheckStatus, number> {
  const summary: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) summary[c.status] += 1;
  return summary;
}

export async function doctor(ctx: Context): Promise<number> {
  const checks = await runDoctor(ctx);
  const summary = summarize(checks);
  const ok = summary.fail === 0;
  const { io } = ctx.deps;
  if (ctx.opts.json) {
    io.out(JSON.stringify({ ok, summary, checks }, null, 2));
  } else {
    const width = Math.max(...checks.map((c) => c.id.length));
    for (const c of checks)
      io.out(`${c.status.toUpperCase().padEnd(4)}  ${c.id.padEnd(width)}  ${c.detail}`);
    io.out(
      `doctor: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail, ${summary.skip} skip`,
    );
  }
  return ok ? 0 : 1;
}
