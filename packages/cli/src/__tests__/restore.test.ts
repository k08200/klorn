import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256File, writeChecksum } from "../backup/store.js";
import { backupRestore } from "../commands/restore.js";
import { HOSTED_PROD_REF } from "../db/target.js";
import { CliError, UsageError } from "../errors.js";
import { HEALTH_OK, harness, jsonResponse, type RecordedCall, runs, writeDump } from "./helpers.js";

async function seedBackup(backupDir: string): Promise<string> {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const path = join(backupDir, "klorn-20261101T000000Z.dump");
  writeFileSync(path, "PGDMP-seed", { mode: 0o600 });
  writeChecksum(path, await sha256File(path));
  return path;
}

const isList = (c: RecordedCall) => runs(c, "pg_restore") && runs(c, "--list");
const isScript = (c: RecordedCall) => runs(c, "pg_restore") && runs(c, "--file=-");
const isApply = (c: RecordedCall) => runs(c, "psql") && runs(c, "--single-transaction");
const restored = (calls: RecordedCall[]) => calls.some(isApply);

/** Answers a restore: archive listing, snapshot dump, script render, api state. */
const restoreHandler =
  (apiActive: boolean, applyFails = false) =>
  (call: RecordedCall) => {
    if (runs(call, "pg_dump")) return writeDump(call);
    if (isList(call)) return { stdout: ";\n; Archive created at 2026-11-01\n" };
    if (isScript(call)) return writeDump(call, "BEGIN;\n");
    if (call.argv.includes("ps")) return { stdout: apiActive ? "3f2a\n" : "" };
    if (isApply(call) && applyFails) return { code: 3, stderr: "ERROR: boom" };
    return undefined;
  };

const step = (c: RecordedCall) => {
  if (isList(c)) return "list";
  if (runs(c, "pg_dump")) return "snapshot";
  if (isScript(c)) return "script";
  if (isApply(c)) return "apply";
  return c.argv.slice(c.argv.indexOf("-f") + 2).join(" ");
};

describe("klorn backup restore — guards", () => {
  it("requires an explicit --target", async () => {
    const h = harness({ opts: { yes: true } });
    const file = await seedBackup(h.backupDir);
    await expect(backupRestore(h.ctx, file)).rejects.toThrow(UsageError);
    expect(h.calls).toEqual([]);
  });

  it("refuses a target that looks like Klorn's hosted production, before touching anything", async () => {
    const h = harness({
      opts: { yes: true, target: "env:PROD_URL" },
      shellEnv: {
        PROD_URL: `postgresql://postgres.${HOSTED_PROD_REF}:pw@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres`,
      },
    });
    const file = await seedBackup(h.backupDir);
    const err = await backupRestore(h.ctx, file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(String(err)).toMatch(/hosted production/);
    expect(String(err)).not.toContain(":pw@");
    expect(h.calls).toEqual([]);
  });

  it("lets --i-know through the production guard", async () => {
    const h = harness({
      opts: {
        yes: true,
        iKnow: true,
        noBackup: true,
        target: `postgresql://postgres@db.${HOSTED_PROD_REF}.supabase.co/postgres`,
      },
      handler: restoreHandler(false),
    });
    const file = await seedBackup(h.backupDir);
    await expect(backupRestore(h.ctx, file)).resolves.toBe(0);
    expect(restored(h.calls)).toBe(true);
  });

  it("refuses a dump whose checksum does not match", async () => {
    const h = harness({ opts: { yes: true, target: "compose" } });
    const file = await seedBackup(h.backupDir);
    writeFileSync(file, "PGDMP-tampered");
    await expect(backupRestore(h.ctx, file)).rejects.toThrow(/checksum mismatch/);
    expect(h.calls).toEqual([]);
  });

  it("refuses a dump with no checksum and says how to vouch for it", async () => {
    const h = harness({ opts: { yes: true, target: "compose" } });
    mkdirSync(h.backupDir, { mode: 0o700 });
    const file = join(h.backupDir, "klorn-20261101T000000Z.dump");
    writeFileSync(file, "PGDMP-by-hand");
    await expect(backupRestore(h.ctx, file)).rejects.toThrow(/sha256sum/);
    expect(h.calls).toEqual([]);
  });

  it("refuses without --yes when nobody can answer the prompt", async () => {
    const h = harness({ opts: { target: "compose" }, handler: restoreHandler(true) });
    const file = await seedBackup(h.backupDir);
    await expect(backupRestore(h.ctx, file)).rejects.toThrow(/--yes/);
    expect(restored(h.calls)).toBe(false);
  });

  it("refuses when the typed database name does not match", async () => {
    const h = harness({
      opts: { target: "compose" },
      interactive: true,
      answers: ["klorn_prod"],
      handler: restoreHandler(true),
    });
    const file = await seedBackup(h.backupDir);
    await expect(backupRestore(h.ctx, file)).rejects.toThrow(/did not match/);
    expect(restored(h.calls)).toBe(false);
  });

  it("refuses a dump swapped out after it was verified", async () => {
    const h = harness({
      opts: { target: "compose", yes: true },
      handler: (call) => {
        // The swap happens while the pre-restore snapshot runs.
        if (runs(call, "pg_dump"))
          writeFileSync(join(h.backupDir, "klorn-20261101T000000Z.dump"), "evil");
        return restoreHandler(true)(call);
      },
    });
    const file = await seedBackup(h.backupDir);
    await expect(backupRestore(h.ctx, file)).rejects.toThrow(/checksum mismatch/);
    expect(restored(h.calls)).toBe(false);
    expect(h.commands().at(-1)).toMatch(/ up -d --no-deps api$/);
  });
});

describe("klorn backup restore — compose", () => {
  it("verifies, stops writers, snapshots, restores in one transaction, restarts and waits", async () => {
    const h = harness({
      opts: { target: "compose" },
      interactive: true,
      answers: ["klorn"],
      handler: restoreHandler(true),
      fetch: () => jsonResponse(HEALTH_OK),
    });
    const file = await seedBackup(h.backupDir);
    await expect(backupRestore(h.ctx, file)).resolves.toBe(0);
    expect(h.calls.map(step)).toEqual([
      "list",
      "ps --status running --status restarting -q api",
      "stop api",
      "snapshot",
      "script",
      "apply",
      "up -d --no-deps api",
    ]);
    expect(h.calls.find(isScript)?.opts?.stdinFile).toBe(file);
    expect(readdirSync(h.backupDir).filter((n) => n.endsWith(".dump"))).toContain(
      "klorn-20261115T083000Z-pre-restore.dump",
    );
    expect(readdirSync(h.backupDir).some((n) => n.startsWith(".restore-"))).toBe(false);
    expect(h.out.join("\n")).toMatch(/api is back: ok/);
  });

  it("brings the api back up when the restore fails", async () => {
    const h = harness({
      opts: { target: "compose", yes: true, noBackup: true },
      handler: restoreHandler(true, true),
    });
    const file = await seedBackup(h.backupDir);
    await expect(backupRestore(h.ctx, file)).rejects.toThrow(/boom/);
    expect(h.commands().at(-1)).toMatch(/ up -d --no-deps api$/);
  });

  it("fails when the restarted api does not come back healthy", async () => {
    const h = harness({
      opts: { target: "compose", yes: true, noBackup: true, timeoutSec: 10 },
      handler: restoreHandler(true),
      fetch: () => jsonResponse({ ...HEALTH_OK, status: "degraded", db: "unreachable" }),
    });
    const file = await seedBackup(h.backupDir);
    await expect(backupRestore(h.ctx, file)).rejects.toThrow(/did not come back healthy/);
  });

  it("leaves an api that was not running alone, and skips the snapshot with --no-backup", async () => {
    const h = harness({
      opts: { target: "compose", yes: true, noBackup: true },
      handler: restoreHandler(false),
    });
    const file = await seedBackup(h.backupDir);
    await expect(backupRestore(h.ctx, file)).resolves.toBe(0);
    expect(h.commands().some((c) => / (stop|up -d --no-deps) api$/.test(c))).toBe(false);
    expect(h.calls.some((c) => runs(c, "pg_dump"))).toBe(false);
  });

  it("resolves a bare file name inside the backup directory", async () => {
    const h = harness({
      opts: { target: "compose", yes: true, noBackup: true },
      handler: restoreHandler(false),
    });
    const file = await seedBackup(h.backupDir);
    await expect(backupRestore(h.ctx, "klorn-20261101T000000Z.dump")).resolves.toBe(0);
    expect(existsSync(file)).toBe(true);
  });
});
