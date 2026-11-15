import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  backupFileName,
  ensureBackupDir,
  listBackups,
  sha256File,
  verifyChecksum,
  writeChecksum,
} from "../backup/store.js";
import { backupCreate, backupList } from "../commands/backup.js";
import { CliError, UsageError } from "../errors.js";
import { harness, runs, writeDump } from "./helpers.js";

const NOW = new Date("2026-11-15T08:30:05.123Z");

describe("backup store", () => {
  it("names backups by UTC second, with an optional label", () => {
    expect(backupFileName(NOW)).toBe("klorn-20261115T083005Z.dump");
    expect(backupFileName(NOW, "pre-upgrade-0.4.1")).toBe(
      "klorn-20261115T083005Z-pre-upgrade-0.4.1.dump",
    );
  });

  it("rejects labels that are not plain lowercase words", () => {
    expect(() => backupFileName(NOW, "../etc")).toThrow(UsageError);
    expect(() => backupFileName(NOW, "Has Space")).toThrow(UsageError);
  });

  it("creates the backup directory private to the owner", () => {
    const { backupDir } = harness();
    expect(ensureBackupDir(backupDir)).toEqual({ loosePermissions: false });
    expect(statSync(backupDir).mode & 0o777).toBe(0o700);
  });

  it("reports an existing directory that others can read", () => {
    const { backupDir } = harness();
    mkdirSync(backupDir, { mode: 0o755 });
    expect(ensureBackupDir(backupDir)).toEqual({ loosePermissions: true });
  });

  it("refuses an existing directory that other users can write to", () => {
    const { backupDir } = harness();
    mkdirSync(backupDir);
    chmodSync(backupDir, 0o777);
    expect(() => ensureBackupDir(backupDir)).toThrow(/writable by other users/);
  });

  it("never writes a checksum through a pre-planted file or symlink", () => {
    const { backupDir } = harness();
    mkdirSync(backupDir);
    const path = join(backupDir, "klorn-20261101T000000Z.dump");
    const victim = join(backupDir, "victim.txt");
    writeFileSync(victim, "keep");
    symlinkSync(victim, `${path}.sha256`);
    expect(() => writeChecksum(path, "ab".repeat(32))).toThrow(/EEXIST/);
    expect(readFileSync(victim, "utf8")).toBe("keep");
  });

  it("lists backups newest first and ignores everything else", async () => {
    const { backupDir } = harness();
    mkdirSync(backupDir);
    for (const name of [
      "klorn-20261101T000000Z.dump",
      "klorn-20261114T120000Z-pre-upgrade-0.4.1.dump",
      "notes.txt",
      "klorn-20261110T000000Z.dump.partial",
    ]) {
      writeFileSync(join(backupDir, name), "x");
    }
    const path = join(backupDir, "klorn-20261101T000000Z.dump");
    writeChecksum(path, await sha256File(path));
    const entries = listBackups(backupDir);
    expect(entries.map((e) => [e.name, e.label, e.checksum])).toEqual([
      ["klorn-20261114T120000Z-pre-upgrade-0.4.1.dump", "pre-upgrade-0.4.1", false],
      ["klorn-20261101T000000Z.dump", null, true],
    ]);
    expect(entries[0]?.createdAt).toBe("2026-11-14T12:00:00Z");
  });

  it("lists nothing when the directory does not exist yet", () => {
    expect(listBackups("/nonexistent/klorn-backups")).toEqual([]);
  });

  it("verifies the sha256 sidecar", async () => {
    const { backupDir } = harness();
    mkdirSync(backupDir);
    const path = join(backupDir, "klorn-20261101T000000Z.dump");
    writeFileSync(path, "archive");
    await expect(verifyChecksum(path)).resolves.toBe("missing");
    writeChecksum(path, await sha256File(path));
    expect(readFileSync(`${path}.sha256`, "utf8")).toMatch(
      /^[0-9a-f]{64} {2}klorn-20261101T000000Z\.dump\n$/,
    );
    await expect(verifyChecksum(path)).resolves.toBe("ok");
    writeFileSync(path, "tampered");
    await expect(verifyChecksum(path)).resolves.toBe("mismatch");
  });
});

describe("klorn backup create", () => {
  it("dumps the compose database into a private, checksummed file", async () => {
    const h = harness({
      opts: { label: "nightly" },
      handler: (call) => (runs(call, "pg_dump") ? writeDump(call) : undefined),
    });
    await expect(backupCreate(h.ctx)).resolves.toBe(0);
    const files = readdirSync(h.backupDir).sort();
    expect(files).toEqual([
      "klorn-20261115T083000Z-nightly.dump",
      "klorn-20261115T083000Z-nightly.dump.sha256",
    ]);
    const dump = join(h.backupDir, files[0] ?? "");
    expect(statSync(dump).mode & 0o777).toBe(0o600);
    await expect(verifyChecksum(dump)).resolves.toBe("ok");
    expect(h.calls[0]?.argv).toContain("pg_dump");
    expect(h.calls[0]?.opts?.stdoutFile).toBe(`${dump}.partial`);
    expect(h.out.join("\n")).toContain(dump);
  });

  it("removes the partial file when pg_dump fails", async () => {
    const h = harness({
      handler: (call) =>
        runs(call, "pg_dump") ? { ...writeDump(call), code: 1, stderr: "boom" } : undefined,
    });
    await expect(backupCreate(h.ctx)).rejects.toThrow(CliError);
    expect(readdirSync(h.backupDir)).toEqual([]);
  });

  it("refuses an empty dump", async () => {
    const h = harness({
      handler: (call) => (runs(call, "pg_dump") ? writeDump(call, "") : undefined),
    });
    await expect(backupCreate(h.ctx)).rejects.toThrow(/empty/);
    expect(readdirSync(h.backupDir)).toEqual([]);
  });
});

describe("klorn backup list", () => {
  it("prints JSON with --json", async () => {
    const h = harness({ opts: { json: true } });
    mkdirSync(h.backupDir);
    writeFileSync(join(h.backupDir, "klorn-20261101T000000Z.dump"), "abc");
    await expect(backupList(h.ctx)).resolves.toBe(0);
    const parsed = JSON.parse(h.out.join("\n"));
    expect(parsed.backups).toHaveLength(1);
    expect(parsed.backups[0]).toMatchObject({ name: "klorn-20261101T000000Z.dump", bytes: 3 });
  });
});
