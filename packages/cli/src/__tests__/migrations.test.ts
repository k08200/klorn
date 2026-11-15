import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  composeMigrations,
  computeStatus,
  isUpToDate,
  localMigrations,
  parseExpected,
  readApplied,
} from "../db/migrations.js";
import type { PgTools } from "../db/pg.js";
import { parseDbSpec } from "../db/target.js";
import { CliError } from "../errors.js";
import type { CommandSpec, RunOptions, RunResult } from "../lib/exec.js";

const A = "20260314151657_init";
const B = "20260316084239_add_chat_models";
const C = "20261115010000_org_audit_event_created_at_index";

function fakePg(answers: Record<string, string>): PgTools {
  return {
    query: async (sql) => {
      const hit = Object.entries(answers).find(([needle]) => sql.includes(needle));
      if (!hit) throw new Error(`unexpected sql: ${sql}`);
      return hit[1];
    },
    dumpTo: async () => {},
    restoreFrom: async () => {},
    listArchive: async () => "",
    clientVersion: async () => null,
  };
}

describe("computeStatus", () => {
  it("splits migrations into applied, pending, failed and unknown", () => {
    const status = computeStatus(
      [A, B, C],
      [
        { name: A, finished: true, rolledBack: false },
        { name: B, finished: false, rolledBack: false },
        { name: "20250101000000_from_a_newer_image", finished: true, rolledBack: false },
      ],
    );
    expect(status).toEqual({
      expected: [A, B, C],
      applied: [A, "20250101000000_from_a_newer_image"],
      failed: [B],
      pending: [C],
      unknown: ["20250101000000_from_a_newer_image"],
    });
    expect(isUpToDate(status)).toBe(false);
  });

  it("counts a rolled-back attempt followed by a successful one as applied", () => {
    const status = computeStatus(
      [A],
      [
        { name: A, finished: false, rolledBack: true },
        { name: A, finished: true, rolledBack: false },
      ],
    );
    expect(status.applied).toEqual([A]);
    expect(status.failed).toEqual([]);
    expect(isUpToDate(status)).toBe(true);
  });

  it("treats a rolled-back-only migration as pending, not failed", () => {
    const status = computeStatus([A], [{ name: A, finished: false, rolledBack: true }]);
    expect(status.pending).toEqual([A]);
    expect(status.failed).toEqual([]);
  });
});

describe("parseExpected", () => {
  it("keeps migration directories only, sorted", () => {
    expect(parseExpected(`${C}\nmigration_lock.toml\n\n${A}\n${B}\n`)).toEqual([A, B, C]);
  });
});

describe("readApplied", () => {
  it("returns nothing on a fresh database with no _prisma_migrations table", async () => {
    await expect(readApplied(fakePg({ to_regclass: "f" }))).resolves.toEqual([]);
  });

  it("parses the bookkeeping rows", async () => {
    const pg = fakePg({ to_regclass: "t", migration_name: `${A}|t|f\n${B}|f|t` });
    await expect(readApplied(pg)).resolves.toEqual([
      { name: A, finished: true, rolledBack: false },
      { name: B, finished: false, rolledBack: true },
    ]);
  });
});

function recordingRunner(result: Partial<RunResult> = {}) {
  const calls: { spec: CommandSpec; opts?: RunOptions }[] = [];
  const runner = async (spec: CommandSpec, opts?: RunOptions): Promise<RunResult> => {
    calls.push({ spec, opts });
    return { code: 0, stdout: "", stderr: "", ...result };
  };
  return { runner, calls };
}

const compose = { composeFile: "/k/docker-compose.selfhost.yml", envFile: "/k/.env.selfhost" };
const PREFIX = [
  "compose",
  "--env-file",
  "/k/.env.selfhost",
  "-f",
  "/k/docker-compose.selfhost.yml",
];

describe("composeMigrations", () => {
  it("lists the migrations baked into the configured api image", async () => {
    const { runner, calls } = recordingRunner({ stdout: `${A}\nmigration_lock.toml\n` });
    await expect(composeMigrations(compose, runner).expected()).resolves.toEqual([A]);
    expect(calls[0]?.spec).toEqual({
      cmd: "docker",
      args: [
        ...PREFIX,
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "api",
        "ls",
        "-1",
        "/app/packages/api/prisma/migrations",
      ],
    });
  });

  it("deploys with prisma inside a one-off api container, pinned to a version when given", async () => {
    const { runner, calls } = recordingRunner();
    await expect(composeMigrations(compose, runner, "0.4.1").deploy()).resolves.toBeUndefined();
    expect(calls[0]?.spec).toEqual({
      cmd: "docker",
      args: [
        ...PREFIX,
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "-w",
        "/app/packages/api",
        "api",
        "npx",
        "prisma",
        "migrate",
        "deploy",
      ],
      env: { KLORN_VERSION: "0.4.1" },
    });
    expect(calls[0]?.opts).toEqual({ inherit: true });
  });

  it("raises when prisma migrate deploy fails", async () => {
    const { runner } = recordingRunner({ code: 1 });
    await expect(composeMigrations(compose, runner).deploy()).rejects.toThrow(CliError);
  });

  it("raises when the image cannot be listed", async () => {
    const { runner } = recordingRunner({ code: 1, stderr: "no such service: api" });
    await expect(composeMigrations(compose, runner).expected()).rejects.toThrow(/no such service/);
  });
});

describe("localMigrations", () => {
  function fakeRepo(withPrisma: boolean): string {
    const root = mkdtempSync(join(tmpdir(), "klorn-cli-repo-"));
    const dir = join(root, "packages/api/prisma/migrations");
    for (const name of [B, A]) mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, "migration_lock.toml"), "");
    if (withPrisma) {
      mkdirSync(join(root, "packages/api/node_modules/.bin"), { recursive: true });
      writeFileSync(join(root, "packages/api/node_modules/.bin/prisma"), "");
    }
    return root;
  }
  const parsed = parseDbSpec("env:U", () => "postgresql://app:pw@db.test:5432/klorn");
  if (parsed.kind !== "url") throw new Error("expected a url target");
  const target = parsed;

  it("reads migration directories from the checkout", async () => {
    const { runner } = recordingRunner();
    const source = localMigrations(fakeRepo(true), target, runner, {});
    await expect(source.expected()).resolves.toEqual([A, B]);
  });

  it("runs the checkout's prisma with DATABASE_URL in env only", async () => {
    const root = fakeRepo(true);
    const { runner, calls } = recordingRunner();
    await localMigrations(root, target, runner, {}).deploy();
    const spec = calls[0]?.spec;
    expect(spec?.cmd).toBe(join(root, "packages/api/node_modules/.bin/prisma"));
    expect(spec?.args).toEqual(["migrate", "deploy"]);
    expect(spec?.cwd).toBe(join(root, "packages/api"));
    expect(spec?.env).toEqual({ DATABASE_URL: "postgresql://app:pw@db.test:5432/klorn" });
  });

  it("explains how to install prisma when the checkout has none", async () => {
    const { runner } = recordingRunner();
    await expect(localMigrations(fakeRepo(false), target, runner, {}).deploy()).rejects.toThrow(
      /pnpm install --filter @klorn\/api/,
    );
  });
});
