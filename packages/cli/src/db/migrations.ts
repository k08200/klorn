import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../errors.js";
import { type ComposeRef, composeSpec } from "../lib/compose.js";
import { type Runner, tail } from "../lib/exec.js";
import type { PgTools } from "./pg.js";
import { databaseUrlFor, type UrlTarget } from "./target.js";

/**
 * Migration status from Prisma's own bookkeeping (`_prisma_migrations`)
 * against the migration directories the code expects. Read-only, and
 * structured (doctor --json needs it) rather than scraped from the human
 * output of `prisma migrate status`. Applying stays with `prisma migrate deploy`.
 */

export const MIGRATION_NAME = /^\d{14}_[A-Za-z0-9_]+$/;
/** Where Dockerfile.api puts the schema inside the api image. */
export const IMAGE_API_DIR = "/app/packages/api";

export interface AppliedRow {
  name: string;
  finished: boolean;
  rolledBack: boolean;
}

export interface MigrationStatus {
  expected: string[];
  applied: string[];
  /** Started, never finished, never rolled back: `prisma migrate deploy` refuses until resolved. */
  failed: string[];
  pending: string[];
  /** Applied in the database but unknown to this code — the database is ahead (a downgrade). */
  unknown: string[];
}

export function computeStatus(
  expected: readonly string[],
  rows: readonly AppliedRow[],
): MigrationStatus {
  const applied = [...new Set(rows.filter((r) => r.finished && !r.rolledBack).map((r) => r.name))];
  const appliedSet = new Set(applied);
  const failed = [
    ...new Set(
      rows
        .filter((r) => !r.finished && !r.rolledBack && !appliedSet.has(r.name))
        .map((r) => r.name),
    ),
  ];
  const failedSet = new Set(failed);
  const expectedSet = new Set(expected);
  return {
    expected: [...expected],
    applied,
    failed,
    pending: expected.filter((name) => !appliedSet.has(name) && !failedSet.has(name)),
    unknown: applied.filter((name) => !expectedSet.has(name)),
  };
}

export function isUpToDate(status: MigrationStatus): boolean {
  return status.pending.length === 0 && status.failed.length === 0 && status.unknown.length === 0;
}

export function parseExpected(listing: string): string[] {
  return listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => MIGRATION_NAME.test(line))
    .sort();
}

export async function readApplied(pg: PgTools): Promise<AppliedRow[]> {
  const exists = await pg.query("select to_regclass('public._prisma_migrations') is not null");
  if (exists !== "t") return [];
  const out = await pg.query(
    "select migration_name, finished_at is not null, rolled_back_at is not null " +
      "from public._prisma_migrations order by started_at",
  );
  return out
    .split("\n")
    .filter((line) => line.includes("|"))
    .map((line) => {
      const [name = "", finished, rolledBack] = line.split("|");
      return { name, finished: finished === "t", rolledBack: rolledBack === "t" };
    });
}

/** Where the expected migrations come from, and how they are applied. */
export interface MigrationSource {
  expected(): Promise<string[]>;
  /** Runs `prisma migrate deploy`; throws CliError on failure. */
  deploy(): Promise<void>;
}

/** The api image the compose file is configured with (optionally pinned to `version`). */
export function composeMigrations(
  ref: ComposeRef,
  runner: Runner,
  version?: string,
): MigrationSource {
  const env = version ? { KLORN_VERSION: version } : undefined;
  return {
    expected: async () => {
      const spec = composeSpec(
        ref,
        ["run", "--rm", "--no-deps", "-T", "api", "ls", "-1", `${IMAGE_API_DIR}/prisma/migrations`],
        env,
      );
      const result = await runner(spec);
      if (result.code !== 0) {
        throw new CliError(`could not list the api image's migrations:\n${tail(result.stderr, 6)}`);
      }
      return parseExpected(result.stdout);
    },
    deploy: async () => {
      const spec = composeSpec(
        ref,
        [
          "run",
          "--rm",
          "--no-deps",
          "-T",
          "-w",
          IMAGE_API_DIR,
          "api",
          "npx",
          "prisma",
          "migrate",
          "deploy",
        ],
        env,
      );
      const result = await runner(spec, { inherit: true });
      if (result.code !== 0)
        throw new CliError(`prisma migrate deploy failed (exit ${result.code})`);
    },
  };
}

/** This checkout's packages/api, against a URL target (the Render / managed-Postgres path). */
export function localMigrations(
  repoRoot: string,
  target: UrlTarget,
  runner: Runner,
  env: Readonly<Record<string, string | undefined>>,
): MigrationSource {
  const apiDir = join(repoRoot, "packages/api");
  return {
    expected: async () => {
      const dir = join(apiDir, "prisma/migrations");
      const names = (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .join("\n");
      return parseExpected(names);
    },
    deploy: async () => {
      const prisma = join(apiDir, "node_modules/.bin/prisma");
      if (!existsSync(prisma)) {
        throw new CliError(
          `prisma is not installed in ${apiDir} — run \`pnpm install --filter @klorn/api\` first`,
        );
      }
      const result = await runner(
        {
          cmd: prisma,
          args: ["migrate", "deploy"],
          cwd: apiDir,
          env: { DATABASE_URL: databaseUrlFor(target, env) },
        },
        { inherit: true },
      );
      if (result.code !== 0)
        throw new CliError(`prisma migrate deploy failed (exit ${result.code})`);
    },
  };
}

export async function migrationStatus(
  pg: PgTools,
  source: MigrationSource,
): Promise<MigrationStatus> {
  const [expected, rows] = await Promise.all([source.expected(), readApplied(pg)]);
  return computeStatus(expected, rows);
}
