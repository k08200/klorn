import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPgTools,
  DUMP_ARGS,
  escapePgpass,
  RESTORE_APPLY_ARGS,
  RESTORE_SCRIPT_ARGS,
} from "../db/pg.js";
import { parseDbSpec } from "../db/target.js";
import { CliError } from "../errors.js";
import type { CommandSpec, RunOptions, RunResult } from "../lib/exec.js";

const compose = {
  composeFile: "/srv/klorn/docker-compose.selfhost.yml",
  envFile: "/srv/klorn/.env.selfhost",
};
const COMPOSE_PREFIX = [
  "compose",
  "--env-file",
  compose.envFile,
  "-f",
  compose.composeFile,
  "exec",
  "-T",
  "postgres",
];

interface Call {
  spec: CommandSpec;
  opts: RunOptions | undefined;
}

function fakeRunner(respond: (call: Call) => Partial<RunResult> = () => ({})) {
  const calls: Call[] = [];
  const runner = async (spec: CommandSpec, opts?: RunOptions): Promise<RunResult> => {
    const call = { spec, opts };
    calls.push(call);
    return { code: 0, stdout: "", stderr: "", ...respond(call) };
  };
  return { runner, calls };
}

const urlTarget = (url: string) => parseDbSpec("env:U", (n) => (n === "U" ? url : undefined));

describe("createPgTools — compose", () => {
  it("runs psql inside the postgres service over its local socket, with no credential", async () => {
    const { runner, calls } = fakeRunner(() => ({ stdout: "16.4\n" }));
    const pg = createPgTools(
      parseDbSpec("compose", () => undefined),
      runner,
      compose,
    );
    await expect(pg.query("show server_version")).resolves.toBe("16.4");
    expect(calls[0]?.spec).toEqual({
      cmd: "docker",
      args: [
        ...COMPOSE_PREFIX,
        "psql",
        "--username=klorn",
        "--dbname=klorn",
        "-X",
        "-A",
        "-t",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        "show server_version",
      ],
    });
  });

  it("dumps through stdout, and restores as a script applied in one psql transaction", async () => {
    const { runner, calls } = fakeRunner();
    const pg = createPgTools(
      parseDbSpec("compose", () => undefined),
      runner,
      compose,
    );
    await pg.dumpTo("/backups/x.dump.partial");
    const workDir = mkdtempSync(join(tmpdir(), "klorn-cli-pg-"));
    await pg.restoreFrom("/backups/x.dump", workDir);
    expect(calls[0]?.spec.args).toEqual([
      ...COMPOSE_PREFIX,
      "pg_dump",
      "--username=klorn",
      "--dbname=klorn",
      ...DUMP_ARGS,
    ]);
    expect(calls[0]?.opts).toEqual({ stdoutFile: "/backups/x.dump.partial" });
    // 1. archive -> SQL script, no connection
    expect(calls[1]?.spec.args).toEqual([...COMPOSE_PREFIX, "pg_restore", ...RESTORE_SCRIPT_ARGS]);
    const script = calls[1]?.opts?.stdoutFile ?? "";
    expect(calls[1]?.opts?.stdinFile).toBe("/backups/x.dump");
    expect(script.startsWith(join(workDir, ".restore-"))).toBe(true);
    // 2. script -> psql, one transaction that first drops the public schema
    expect(calls[2]?.spec.args).toEqual([
      ...COMPOSE_PREFIX,
      "psql",
      "--username=klorn",
      "--dbname=klorn",
      ...RESTORE_APPLY_ARGS,
    ]);
    expect(RESTORE_APPLY_ARGS).toContain("--single-transaction");
    expect(RESTORE_APPLY_ARGS).toContain("DROP SCHEMA IF EXISTS public CASCADE");
    expect(calls[2]?.opts).toEqual({ stdinFile: script });
    expect(existsSync(script)).toBe(false);
  });

  it("removes the transient restore script when psql fails", async () => {
    const { runner, calls } = fakeRunner(({ spec, opts }) => {
      if (opts?.stdoutFile) writeFileSync(opts.stdoutFile, "BEGIN;");
      return spec.args.includes("psql") ? { code: 3, stderr: "ERROR: boom" } : {};
    });
    const pg = createPgTools(
      parseDbSpec("compose", () => undefined),
      runner,
      compose,
    );
    const workDir = mkdtempSync(join(tmpdir(), "klorn-cli-pg-"));
    await expect(pg.restoreFrom("/backups/x.dump", workDir)).rejects.toThrow(/boom/);
    expect(calls).toHaveLength(2);
    expect(readdirSync(workDir)).toEqual([]);
  });

  it("lists an archive without connecting (pg_restore --list never gets --dbname)", async () => {
    const { runner, calls } = fakeRunner(() => ({ stdout: ";\n; Archive created at ...\n" }));
    const pg = createPgTools(
      parseDbSpec("compose", () => undefined),
      runner,
      compose,
    );
    await pg.listArchive("/backups/x.dump");
    expect(calls[0]?.spec.args).toEqual([...COMPOSE_PREFIX, "pg_restore", "--list"]);
  });
});

describe("createPgTools — url", () => {
  it("passes the connection in env and the password through a temporary 0600 pgpass file", async () => {
    let seen: { path: string; content: string; mode: number } | undefined;
    const { runner, calls } = fakeRunner(({ spec }) => {
      const path = spec.env?.PGPASSFILE ?? "";
      seen = { path, content: readFileSync(path, "utf8"), mode: statSync(path).mode & 0o777 };
      return { stdout: "1\n" };
    });
    const pg = createPgTools(
      urlTarget("postgresql://app:pa%3Ass@db.example.test:6543/klorn?sslmode=require"),
      runner,
      compose,
    );
    await pg.query("select 1");
    const spec = calls[0]?.spec;
    expect(spec?.cmd).toBe("psql");
    expect(spec?.args.join(" ")).not.toMatch(/pa:ss|pa%3Ass|db\.example\.test|app/);
    expect(spec?.args).toContain("--dbname=klorn");
    expect(spec?.env).toMatchObject({
      PGHOST: "db.example.test",
      PGPORT: "6543",
      PGUSER: "app",
      PGSSLMODE: "require",
      // An inherited PGPASSWORD would outrank the pgpass file; blank it.
      PGPASSWORD: "",
    });
    expect(seen?.content).toBe("*:*:*:*:pa\\:ss\n");
    expect(seen?.mode).toBe(0o600);
    expect(existsSync(seen?.path ?? "")).toBe(false);
  });

  it("strips inherited libpq routing variables and never lets an inherited PGUSER pick the role", async () => {
    const { runner, calls } = fakeRunner(() => ({ stdout: "1" }));
    const pg = createPgTools(
      parseDbSpec("postgresql://db.example.test/klorn", () => undefined),
      runner,
      compose,
    );
    await pg.query("select 1");
    expect(calls[0]?.spec.unsetEnv).toEqual(
      expect.arrayContaining(["PGSERVICE", "PGSERVICEFILE", "PGHOSTADDR", "PGSYSCONFDIR"]),
    );
    expect(calls[0]?.spec.env?.PGUSER).toBeTruthy();
  });

  it("writes no pgpass file for calls that do not connect", async () => {
    const { runner, calls } = fakeRunner(() => ({ stdout: "; Archive\n" }));
    const pg = createPgTools(urlTarget("postgresql://app:pw-secret@h/klorn"), runner, compose);
    await pg.listArchive("/backups/x.dump");
    expect(calls[0]?.spec.env).not.toHaveProperty("PGPASSFILE");
  });

  it("removes the pgpass file even when the tool fails", async () => {
    let path = "";
    const { runner } = fakeRunner(({ spec }) => {
      path = spec.env?.PGPASSFILE ?? "";
      return { code: 2, stderr: "FATAL: password authentication failed (secret-pw)" };
    });
    const pg = createPgTools(urlTarget("postgresql://app:secret-pw@h/klorn"), runner, compose);
    const err = await pg.query("select 1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(String(err)).toContain("password authentication failed");
    expect(String(err)).not.toContain("secret-pw");
    expect(existsSync(path)).toBe(false);
  });

  it("leaves PGPASSWORD / ~/.pgpass to libpq when the URL has no password", async () => {
    const { runner, calls } = fakeRunner(() => ({ stdout: "1" }));
    const pg = createPgTools(
      parseDbSpec("postgresql://app@localhost/klorn", () => undefined),
      runner,
      compose,
    );
    await pg.query("select 1");
    expect(calls[0]?.spec.env).not.toHaveProperty("PGPASSFILE");
    expect(calls[0]?.spec.env).not.toHaveProperty("PGPASSWORD");
  });

  it("reads the client pg_dump version", async () => {
    const { runner } = fakeRunner(() => ({ stdout: "pg_dump (PostgreSQL) 16.4 (Homebrew)\n" }));
    const pg = createPgTools(
      parseDbSpec("postgresql://a@h/d", () => undefined),
      runner,
      compose,
    );
    await expect(pg.clientVersion()).resolves.toBe("16.4");
  });

  it("reports a missing pg_dump as null", async () => {
    const { runner } = fakeRunner(() => ({ code: 127, stderr: "pg_dump: command not found" }));
    const pg = createPgTools(
      parseDbSpec("postgresql://a@h/d", () => undefined),
      runner,
      compose,
    );
    await expect(pg.clientVersion()).resolves.toBeNull();
  });
});

describe("escapePgpass", () => {
  it("escapes backslash and colon", () => {
    expect(escapePgpass("a\\b:c")).toBe("a\\\\b\\:c");
  });
});
