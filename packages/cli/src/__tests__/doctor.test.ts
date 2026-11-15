import { chmodSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Check } from "../checks/types.js";
import { doctor, runDoctor } from "../commands/doctor.js";
import { GOOD_ENV, HEALTH_OK, harness, jsonResponse, type RecordedCall, runs } from "./helpers.js";

const A = "20260314151657_init";
const B = "20261115010000_org_audit_event_created_at_index";

interface StackOpts {
  pgDown?: boolean;
  applied?: string[];
  clientVersion?: string | null;
}

function stack({ pgDown = false, applied = [A, B], clientVersion = "16.4" }: StackOpts = {}) {
  return (call: RecordedCall) => {
    if (call.argv.includes("version") && call.argv.includes("compose"))
      return { stdout: "5.2.0\n" };
    if (call.argv.includes("ls")) return { stdout: `${A}\n${B}\n` };
    if (runs(call, "pg_dump") && call.argv.includes("--version")) {
      return clientVersion ? { stdout: `pg_dump (PostgreSQL) ${clientVersion}\n` } : { code: 127 };
    }
    if (runs(call, "psql")) {
      if (pgDown)
        return {
          code: 2,
          stderr: 'psql: error: connection to server failed: service "postgres" is not running',
        };
      const sql = call.argv.at(-1) ?? "";
      if (sql.includes("server_version")) return { stdout: "16.4 (Debian 16.4-1.pgdg120+2)\n" };
      if (sql.includes("to_regclass")) return { stdout: "t\n" };
      if (sql.includes("migration_name"))
        return { stdout: applied.map((n) => `${n}|t|f`).join("\n") };
      if (sql.includes("pg_database_size")) return { stdout: "1048576\n" };
    }
    return undefined;
  };
}

const okFetch =
  (overrides: Partial<typeof HEALTH_OK> = {}) =>
  (url: string) =>
    url.endsWith("/api/health")
      ? jsonResponse({ ...HEALTH_OK, ...overrides })
      : new Response("<html>klorn</html>", { status: 200 });

const status = (checks: Check[], id: string) => checks.find((c) => c.id === id)?.status;

describe("klorn doctor", () => {
  it("passes a healthy compose stack and exits 0", async () => {
    const h = harness({ handler: stack(), fetch: okFetch() });
    const checks = await runDoctor(h.ctx);
    expect(checks.filter((c) => c.status !== "pass")).toEqual([]);
    expect(checks.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        "env.file",
        "env.JWT_SECRET",
        "docker",
        "compose.file",
        "postgres",
        "pg_dump",
        "migrations",
        "disk",
        "api",
        "clock",
        "web",
      ]),
    );
    expect(checks.find((c) => c.id === "postgres")?.detail).toContain("PostgreSQL 16.4");
    expect(checks.find((c) => c.id === "api")?.detail).toContain("version 0.4.0");
    await expect(doctor(h.ctx)).resolves.toBe(0);
  });

  it("prints machine-readable JSON with --json and never a secret", async () => {
    const h = harness({ handler: stack(), fetch: okFetch(), opts: { json: true } });
    await expect(doctor(h.ctx)).resolves.toBe(0);
    const text = h.out.join("\n");
    const parsed = JSON.parse(text);
    expect(parsed.ok).toBe(true);
    expect(parsed.summary).toMatchObject({ fail: 0 });
    for (const line of GOOD_ENV.split("\n").filter(Boolean)) {
      const value = line.slice(line.indexOf("=") + 1);
      expect(text).not.toContain(value);
    }
  });

  it("fails and skips what depends on Postgres when it is unreachable", async () => {
    const h = harness({ handler: stack({ pgDown: true }), fetch: okFetch() });
    const checks = await runDoctor(h.ctx);
    expect(status(checks, "postgres")).toBe("fail");
    expect(status(checks, "migrations")).toBe("skip");
    await expect(doctor(h.ctx)).resolves.toBe(1);
  });

  it("warns on pending migrations without failing", async () => {
    const h = harness({ handler: stack({ applied: [A] }), fetch: okFetch() });
    const checks = await runDoctor(h.ctx);
    expect(checks.find((c) => c.id === "migrations")).toMatchObject({ status: "warn" });
    expect(checks.find((c) => c.id === "migrations")?.detail).toContain(B);
  });

  it("fails a degraded API and an unreachable web app", async () => {
    const h = harness({
      handler: stack(),
      fetch: (url) =>
        url.endsWith("/api/health")
          ? jsonResponse({ ...HEALTH_OK, status: "degraded", db: "unreachable" })
          : Promise.reject(new TypeError("fetch failed")),
    });
    const checks = await runDoctor(h.ctx);
    expect(status(checks, "api")).toBe("fail");
    expect(status(checks, "web")).toBe("fail");
  });

  it("warns when the API clock is far from this host's", async () => {
    const h = harness({
      handler: stack(),
      fetch: okFetch({ timestamp: "2026-11-15T08:32:00.000Z" }),
    });
    const checks = await runDoctor(h.ctx);
    expect(checks.find((c) => c.id === "clock")).toMatchObject({ status: "warn" });
  });

  it("fails without an env file on the compose path and points at the example", async () => {
    const h = harness({ envFile: null, handler: stack(), fetch: okFetch() });
    const checks = await runDoctor(h.ctx);
    expect(checks.find((c) => c.id === "env.file")).toMatchObject({ status: "fail" });
    expect(checks.find((c) => c.id === "env.file")?.detail).toContain(".env.selfhost.example");
    expect(checks.some((c) => c.id === "env.JWT_SECRET")).toBe(false);
  });

  it("on a URL target: no docker checks, and a host pg_dump older than the server fails", async () => {
    const h = harness({
      envFile: null,
      opts: { db: "env:DB" },
      shellEnv: { DB: "postgresql://app:pw@db.example.test:5432/klorn" },
      handler: stack({ clientVersion: "15.8" }),
      fetch: okFetch(),
    });
    const checks = await runDoctor(h.ctx);
    expect(checks.some((c) => c.id === "docker")).toBe(false);
    expect(status(checks, "env.file")).toBe("skip");
    expect(checks.find((c) => c.id === "pg_dump")).toMatchObject({ status: "fail" });
  });

  it("warns about a remote URL target without sslmode=require", async () => {
    const h = harness({
      envFile: null,
      opts: { db: "postgresql://app@db.example.test/klorn" },
      handler: stack(),
      fetch: okFetch(),
    });
    const checks = await runDoctor(h.ctx);
    expect(checks.find((c) => c.id === "postgres.tls")).toMatchObject({ status: "warn" });
  });

  it("warns when the env file is readable by other users", async () => {
    const h = harness({ handler: stack(), fetch: okFetch() });
    chmodSync(h.ctx.envFile.path, 0o644);
    const checks = await runDoctor(h.ctx);
    expect(checks.find((c) => c.id === "env.file")).toMatchObject({ status: "warn" });
  });

  it("warns when pg_dump is not installed on a URL target", async () => {
    const h = harness({
      envFile: null,
      opts: { db: "postgresql://app@db.example.test/klorn" },
      handler: stack({ clientVersion: null }),
      fetch: okFetch(),
    });
    const checks = await runDoctor(h.ctx);
    expect(checks.find((c) => c.id === "pg_dump")).toMatchObject({ status: "warn" });
  });
});
