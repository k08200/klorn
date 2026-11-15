import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyChecksum } from "../backup/store.js";
import { type Deps, realDeps } from "../context.js";
import { HOSTED_PROD_REF } from "../db/target.js";
import { spawnRunner } from "../lib/exec.js";
import { REPO_ROOT, run } from "../main.js";

/**
 * The CLI against a real Postgres 16, end to end: migrate status/deploy with
 * the checkout's real prisma, doctor, backup create/list, and every restore
 * guard plus two real restores (over a populated database, and into an empty
 * one). Opt-in — it needs a running Postgres container:
 *
 *   KLORN_CLI_IT_CONTAINER=klorn-preview-pg \
 *   KLORN_CLI_IT_BASE_URL=postgresql://postgres:<pw>@localhost:55432 \
 *   pnpm --filter @klorn/cli test -- cli-pg
 *
 * It creates two uniquely named scratch databases (klorn_cli_it_<hex>[_b])
 * and drops them afterwards; it never touches any other database. The host
 * needs no PostgreSQL client: a PATH shim runs psql / pg_dump / pg_restore
 * inside the container, so the real binaries do the work while the CLI runs
 * its URL code path (connection in PG* env, password in a 0600 PGPASSFILE).
 */

const CONTAINER = process.env.KLORN_CLI_IT_CONTAINER ?? "";
const BASE_URL = process.env.KLORN_CLI_IT_BASE_URL ?? "";
const SCRATCH = /^klorn_cli_it_[0-9a-f]{8}(_b)?$/;

const suffix = randomBytes(4).toString("hex");
const DB = `klorn_cli_it_${suffix}`;
const DB_EMPTY = `klorn_cli_it_${suffix}_b`;

async function admin(sql: string, database = "postgres"): Promise<string> {
  const result = await spawnRunner({
    cmd: "docker",
    args: [
      "exec",
      CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      database,
      "-X",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
  });
  if (result.code !== 0) throw new Error(`admin sql failed: ${result.stderr}`);
  return result.stdout.trim();
}

function writeShims(dir: string): void {
  for (const tool of ["psql", "pg_dump", "pg_restore"]) {
    const path = join(dir, tool);
    writeFileSync(
      path,
      [
        "#!/bin/sh",
        'if [ -n "$PGPASSFILE" ] && [ ! -r "$PGPASSFILE" ]; then echo "shim: PGPASSFILE unreadable" >&2; exit 97; fi',
        `exec docker exec -i -e PGUSER -e PGHOST=/var/run/postgresql ${CONTAINER} ${tool} "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(path, 0o755);
  }
}

describe.skipIf(!CONTAINER || !BASE_URL)("klorn CLI against a real Postgres", () => {
  const out: string[] = [];
  const err: string[] = [];
  const work = mkdtempSync(join(tmpdir(), "klorn-cli-it-"));
  const backupDir = join(work, "backups");
  let deps: Deps;

  const cli = async (...argv: string[]) => {
    out.length = 0;
    err.length = 0;
    const code = await run([...argv, "--backup-dir", backupDir], deps);
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  };
  const users = async (database = DB) =>
    Number(await admin('select count(*) from "User"', database));
  const addUser = (id: string) =>
    admin(
      `insert into "User"(id, email, "updatedAt") values ('${id}', '${id}@example.test', now())`,
      DB,
    );

  beforeAll(async () => {
    expect(DB).toMatch(SCRATCH);
    expect(DB_EMPTY).toMatch(SCRATCH);
    await admin(`CREATE DATABASE ${DB}`);
    await admin(`CREATE DATABASE ${DB_EMPTY}`);
    const shims = join(work, "bin");
    mkdirSync(shims, { recursive: true });
    writeShims(shims);
    vi.stubEnv("PATH", `${shims}:${process.env.PATH ?? ""}`);
    deps = {
      ...realDeps(REPO_ROOT),
      io: {
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        interactive: false,
        ask: async () => "",
      },
      env: {
        ...process.env,
        IT_URL: `${BASE_URL}/${DB}`,
        IT_EMPTY_URL: `${BASE_URL}/${DB_EMPTY}`,
        PROD_LIKE: `postgresql://postgres.${HOSTED_PROD_REF}:x@127.0.0.1:9/postgres`,
      },
    };
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    for (const name of [DB, DB_EMPTY]) {
      if (SCRATCH.test(name)) await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
    rmSync(work, { recursive: true, force: true });
  });

  it("reports every migration pending on an empty database", async () => {
    const { code, stdout } = await cli("migrate", "status", "--db", "env:IT_URL", "--json");
    expect(code).toBe(1);
    const status = JSON.parse(stdout);
    expect(status.appliedCount).toBe(0);
    expect(status.pending.length).toBeGreaterThan(150);
  });

  it("applies them with prisma migrate deploy and then reads up to date", async () => {
    const deploy = await cli("migrate", "deploy", "--db", "env:IT_URL", "--yes", "--no-backup");
    expect(deploy.code, deploy.stderr).toBe(0);
    const { code, stdout } = await cli("migrate", "status", "--db", "env:IT_URL", "--json");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ upToDate: true, pending: [], failed: [] });
  });

  it("doctor passes the database checks", async () => {
    const { stdout } = await cli(
      "doctor",
      "--db",
      "env:IT_URL",
      "--json",
      "--api-url",
      "http://127.0.0.1:9",
      "--web-url",
      "http://127.0.0.1:9",
    );
    const checks = JSON.parse(stdout).checks as { id: string; status: string; detail: string }[];
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    for (const id of ["postgres", "pg_dump", "migrations", "disk"]) {
      expect(byId[id]?.status, `${id}: ${byId[id]?.detail}`).toBe("pass");
    }
    expect(byId.postgres?.detail).toMatch(/PostgreSQL 16/);
    expect(byId.api?.status).toBe("fail");
  });

  let dumpPath = "";

  it("creates a private, checksummed custom-format backup and lists it", async () => {
    await addUser("u1");
    const { code, stdout, stderr } = await cli(
      "backup",
      "create",
      "--db",
      "env:IT_URL",
      "--label",
      "it",
      "--json",
    );
    expect(code, stderr).toBe(0);
    dumpPath = JSON.parse(stdout).backup.path;
    expect(statSync(dumpPath).mode & 0o777).toBe(0o600);
    expect(statSync(backupDir).mode & 0o777).toBe(0o700);
    await expect(verifyChecksum(dumpPath)).resolves.toBe("ok");
    const list = await cli("backup", "list", "--json");
    expect(JSON.parse(list.stdout).backups).toHaveLength(1);
  });

  it("refuses a production-looking target, a missing --yes, and a tampered dump", async () => {
    await addUser("u2");
    const prod = await cli("backup", "restore", dumpPath, "--target", "env:PROD_LIKE", "--yes");
    expect(prod.code).toBe(1);
    expect(prod.stderr).toMatch(/hosted production/);

    const noYes = await cli("backup", "restore", dumpPath, "--target", "env:IT_URL");
    expect(noYes.code).toBe(1);
    expect(noYes.stderr).toMatch(/--yes/);

    const tamperedDir = join(work, "tampered");
    mkdirSync(tamperedDir);
    const tampered = join(tamperedDir, "klorn-20260101T000000Z.dump");
    copyFileSync(dumpPath, tampered);
    copyFileSync(`${dumpPath}.sha256`, `${tampered}.sha256`);
    writeFileSync(tampered, "x", { flag: "a" });
    const bad = await cli("backup", "restore", tampered, "--target", "env:IT_URL", "--yes");
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/checksum mismatch/);

    expect(await users()).toBe(2);
  });

  it("restores over the populated database, after a pre-restore snapshot", async () => {
    const { code, stderr } = await cli(
      "backup",
      "restore",
      dumpPath,
      "--target",
      "env:IT_URL",
      "--yes",
    );
    expect(code, stderr).toBe(0);
    expect(await users()).toBe(1);
    const dumps = readdirSync(backupDir).filter((n) => n.endsWith(".dump"));
    expect(dumps.some((n) => n.includes("-pre-restore"))).toBe(true);
    const status = await cli("migrate", "status", "--db", "env:IT_URL");
    expect(status.code).toBe(0);
  });

  it("rolls back over objects a newer migration added (upgrade rollback)", async () => {
    await admin('create table "FromANewerRelease"(id int)', DB);
    await admin(
      "insert into _prisma_migrations(id, checksum, migration_name, started_at, finished_at, applied_steps_count) " +
        "values ('it-newer', 'x', '29990101000000_from_a_newer_release', now(), now(), 1)",
      DB,
    );
    const ahead = await cli("migrate", "status", "--db", "env:IT_URL", "--json");
    expect(JSON.parse(ahead.stdout).unknown).toEqual(["29990101000000_from_a_newer_release"]);

    const { code, stderr } = await cli(
      "backup",
      "restore",
      dumpPath,
      "--target",
      "env:IT_URL",
      "--yes",
      "--no-backup",
    );
    expect(code, stderr).toBe(0);
    expect(await admin(`select to_regclass('public."FromANewerRelease"') is null`, DB)).toBe("t");
    const after = await cli("migrate", "status", "--db", "env:IT_URL", "--json");
    expect(JSON.parse(after.stdout)).toMatchObject({ upToDate: true, unknown: [] });
    const redeploy = await cli("migrate", "deploy", "--db", "env:IT_URL", "--yes", "--no-backup");
    expect(redeploy.code, redeploy.stderr).toBe(0);
    expect(redeploy.stdout).toMatch(/nothing to apply/);
  });

  it("restores into an empty database (disaster recovery)", async () => {
    const { code, stderr } = await cli(
      "backup",
      "restore",
      dumpPath,
      "--target",
      "env:IT_EMPTY_URL",
      "--yes",
      "--no-backup",
    );
    expect(code, stderr).toBe(0);
    expect(await users(DB_EMPTY)).toBe(1);
    const status = await cli("migrate", "status", "--db", "env:IT_EMPTY_URL", "--json");
    expect(JSON.parse(status.stdout)).toMatchObject({ upToDate: true });
  });
});
