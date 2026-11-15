import { describe, expect, it } from "vitest";
import { migrateDeploy, migrateStatus } from "../commands/migrate.js";
import { CliError } from "../errors.js";
import { harness, type RecordedCall, runs, writeDump } from "./helpers.js";

const A = "20260314151657_init";
const B = "20261115010000_org_audit_event_created_at_index";

/** A compose stack whose image knows A and B; the database has `applied` (mutable). */
function stack(applied: string[], failed: string[] = []) {
  const state = { applied: [...applied], deployed: false };
  const handler = (call: RecordedCall) => {
    if (call.argv.includes("ls")) return { stdout: `${A}\n${B}\nmigration_lock.toml\n` };
    if (call.argv.includes("migrate") && call.argv.includes("deploy")) {
      state.deployed = true;
      state.applied = [A, B];
      return {};
    }
    if (runs(call, "pg_dump")) return writeDump(call);
    const sql = call.argv.at(-1) ?? "";
    if (sql.includes("to_regclass")) return { stdout: "t\n" };
    if (sql.includes("migration_name")) {
      const rows = [...state.applied.map((n) => `${n}|t|f`), ...failed.map((n) => `${n}|f|f`)];
      return { stdout: `${rows.join("\n")}\n` };
    }
    return undefined;
  };
  return { state, handler };
}

const step = (call: RecordedCall) => {
  if (runs(call, "pg_dump")) return "backup";
  if (call.argv.includes("deploy")) return "deploy";
  if (call.argv.includes("ls")) return "list";
  return "query";
};

describe("klorn migrate status", () => {
  it("exits 0 and reports up to date", async () => {
    const { handler } = stack([A, B]);
    const h = harness({ handler, opts: { json: true } });
    await expect(migrateStatus(h.ctx)).resolves.toBe(0);
    expect(JSON.parse(h.out.join("\n"))).toEqual({
      target: "compose postgres (klorn)",
      upToDate: true,
      appliedCount: 2,
      pending: [],
      failed: [],
      unknown: [],
    });
  });

  it("exits 1 and names pending migrations", async () => {
    const { handler } = stack([A]);
    const h = harness({ handler });
    await expect(migrateStatus(h.ctx)).resolves.toBe(1);
    expect(h.out.join("\n")).toContain(`pending  ${B}`);
  });
});

describe("klorn migrate deploy", () => {
  it("refuses without --yes in a non-interactive shell, before backing up or applying", async () => {
    const { state, handler } = stack([A]);
    const h = harness({ handler });
    await expect(migrateDeploy(h.ctx)).rejects.toThrow(/--yes/);
    expect(state.deployed).toBe(false);
    expect(h.calls.some((c) => runs(c, "pg_dump"))).toBe(false);
  });

  it("backs up first, then applies, then re-checks", async () => {
    const { state, handler } = stack([A]);
    const h = harness({ handler, opts: { yes: true } });
    await expect(migrateDeploy(h.ctx)).resolves.toBe(0);
    expect(state.deployed).toBe(true);
    const steps = h.calls.map(step);
    expect(steps.indexOf("backup")).toBeLessThan(steps.indexOf("deploy"));
    expect(steps.lastIndexOf("query")).toBeGreaterThan(steps.indexOf("deploy"));
    expect(h.out.join("\n")).toMatch(/up to date/);
  });

  it("asks interactively and skips the backup with --no-backup", async () => {
    const { state, handler } = stack([A]);
    const h = harness({ handler, opts: { noBackup: true }, interactive: true, answers: ["y"] });
    await expect(migrateDeploy(h.ctx)).resolves.toBe(0);
    expect(state.deployed).toBe(true);
    expect(h.calls.some((c) => runs(c, "pg_dump"))).toBe(false);
  });

  it("does nothing when there is nothing to apply", async () => {
    const { state, handler } = stack([A, B]);
    const h = harness({ handler, opts: { yes: true } });
    await expect(migrateDeploy(h.ctx)).resolves.toBe(0);
    expect(state.deployed).toBe(false);
    expect(h.calls.some((c) => runs(c, "pg_dump"))).toBe(false);
  });

  it("refuses Klorn's hosted production database unless --i-know", async () => {
    const { state, handler } = stack([A]);
    const h = harness({
      handler,
      opts: { yes: true, db: "env:PROD" },
      shellEnv: {
        PROD: "postgresql://postgres.wqqjldncizvmandepobc:x@aws-0.pooler.supabase.com/postgres",
      },
    });
    await expect(migrateDeploy(h.ctx)).rejects.toThrow(/hosted production/);
    expect(h.calls).toEqual([]);
    expect(state.deployed).toBe(false);
  });

  it("refuses while a migration is marked failed", async () => {
    const { state, handler } = stack([A], [B]);
    const h = harness({ handler, opts: { yes: true } });
    await expect(migrateDeploy(h.ctx)).rejects.toThrow(CliError);
    await expect(migrateDeploy(h.ctx)).rejects.toThrow(/prisma migrate resolve/);
    expect(state.deployed).toBe(false);
  });
});
