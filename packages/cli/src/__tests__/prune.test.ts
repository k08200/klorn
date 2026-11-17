import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planPrune, prune } from "../backup/prune.js";
import { listBackups } from "../backup/store.js";
import { backupPrune } from "../commands/backup.js";
import { CliError, UsageError } from "../errors.js";
import { run } from "../main.js";
import { type HarnessInput, harness } from "./helpers.js";

// "Now" in the harness is 2026-11-15T08:30:00Z. Ages below are against it.
const N1 = "klorn-20261114T020000Z.dump"; //                     ~1 day
const N2 = "klorn-20261110T020000Z-pre-upgrade-0.4.0.dump"; //   ~5 days
const N3 = "klorn-20261101T020000Z.dump"; //                     ~14 days
const N4 = "klorn-20261015T020000Z.dump"; //                     ~31 days
const N5 = "klorn-20260901T020000Z.dump"; //                     ~75 days
const ALL = [N1, N2, N3, N4, N5];
const DUMP_BYTES = 1000;
const SUM_BYTES = 70;
const PER_BACKUP = DUMP_BYTES + SUM_BYTES;
const NOW_MS = Date.parse("2026-11-15T08:30:00.000Z");

function backupDirWith(h: { backupDir: string }, names: readonly string[] = ALL): void {
  mkdirSync(h.backupDir, { mode: 0o700 });
  for (const name of names) {
    writeFileSync(join(h.backupDir, name), "d".repeat(DUMP_BYTES), { mode: 0o600 });
    writeFileSync(join(h.backupDir, `${name}.sha256`), "s".repeat(SUM_BYTES), { mode: 0o600 });
  }
}

const realRemove = (path: string) => unlinkSync(path);
const files = (dir: string) => readdirSync(dir).sort();
const dumps = (dir: string) => files(dir).filter((n) => n.endsWith(".dump"));

function prunable(input: HarnessInput = {}) {
  const h = harness(input);
  backupDirWith(h);
  return h;
}

describe("planPrune", () => {
  const entries = (dir: string) => listBackups(dir);
  const names = (list: readonly { name: string }[]) => list.map((e) => e.name);

  it("--keep N deletes everything beyond the N newest", () => {
    const h = prunable();
    const plan = planPrune(entries(h.backupDir), { keep: 2 }, NOW_MS);
    expect(names(plan.kept)).toEqual([N1, N2]);
    expect(names(plan.doomed)).toEqual([N3, N4, N5]);
  });

  it("--older-than D deletes only backups older than D days", () => {
    const h = prunable();
    const plan = planPrune(entries(h.backupDir), { olderThanDays: 30 }, NOW_MS);
    expect(names(plan.doomed)).toEqual([N4, N5]);
    expect(names(plan.kept)).toEqual([N1, N2, N3]);
  });

  it("combined rules delete only what BOTH select: beyond the newest N and older than D days", () => {
    const h = prunable();
    // N4 is older than 30 days but is still among the 4 newest: kept.
    const wide = planPrune(entries(h.backupDir), { keep: 4, olderThanDays: 30 }, NOW_MS);
    expect(names(wide.doomed)).toEqual([N5]);
    // N3 is beyond the newest 1 but younger than 30 days: kept.
    const narrow = planPrune(entries(h.backupDir), { keep: 1, olderThanDays: 30 }, NOW_MS);
    expect(names(narrow.doomed)).toEqual([N4, N5]);
  });

  it("never selects the newest backup, even when every backup is older than the rule", () => {
    const h = prunable();
    const plan = planPrune(entries(h.backupDir), { olderThanDays: 1 }, NOW_MS);
    expect(names(plan.kept)).toEqual([N1]);
    expect(names(plan.doomed)).toEqual([N2, N3, N4, N5]);
  });

  it("leaves a lone backup alone", () => {
    const h = harness();
    backupDirWith(h, [N5]);
    const plan = planPrune(entries(h.backupDir), { keep: 1, olderThanDays: 1 }, NOW_MS);
    expect(plan.doomed).toEqual([]);
  });

  it("ignores names whose timestamp is not a real date, so they cannot shield or displace a backup", () => {
    const h = harness();
    backupDirWith(h, [...ALL, "klorn-20261399T256100Z.dump", "klorn-20260230T000000Z.dump"]);
    const plan = planPrune(entries(h.backupDir), { keep: 1 }, NOW_MS);
    expect(plan.ignored).toBe(2);
    expect(names(plan.kept)).toEqual([N1]);
    expect(names(plan.doomed)).toEqual([N2, N3, N4, N5]);
  });
});

describe("klorn backup prune (dry run is the default)", () => {
  it("deletes nothing and says what it would delete, with the total size", async () => {
    const h = prunable({ opts: { keep: 2 } });
    const before = files(h.backupDir);
    await expect(backupPrune(h.ctx)).resolves.toBe(0);
    expect(files(h.backupDir)).toEqual(before);
    const out = h.out.join("\n");
    expect(out).toMatch(/dry run/i);
    for (const name of [N3, N4, N5]) expect(out).toContain(name);
    for (const name of [N1, N2]) expect(out).not.toContain(name);
    expect(out).toContain("would delete 3 of 5");
    expect(out).toMatch(/re-run with --yes/);
  });

  it("--json reports the plan and the bytes it would free", async () => {
    const h = prunable({ opts: { keep: 2, json: true } });
    await expect(backupPrune(h.ctx)).resolves.toBe(0);
    const report = JSON.parse(h.out.join("\n"));
    expect(report).toMatchObject({
      dir: h.backupDir,
      dryRun: true,
      rules: { keep: 2, olderThanDays: null },
      total: 5,
      kept: 2,
      deleted: [],
      freedBytes: 0,
      candidateBytes: 3 * PER_BACKUP,
      errors: [],
    });
    expect(report.candidates.map((c: { name: string }) => c.name)).toEqual([N3, N4, N5]);
    expect(report.candidates[0]).toMatchObject({ bytes: PER_BACKUP, checksum: true });
  });

  it("says so when nothing is outside the rules", async () => {
    const h = prunable({ opts: { keep: 10 } });
    await expect(backupPrune(h.ctx)).resolves.toBe(0);
    expect(h.out.join("\n")).toMatch(/nothing to prune/);
    expect(dumps(h.backupDir)).toEqual([...ALL].sort());
  });

  it("does not create or complain about a backup directory that does not exist yet", async () => {
    const h = harness({ opts: { keep: 3, yes: true } });
    await expect(backupPrune(h.ctx)).resolves.toBe(0);
    expect(existsSync(h.backupDir)).toBe(false);
    expect(h.out.join("\n")).toMatch(/no backups/);
  });
});

describe("klorn backup prune --yes", () => {
  it("deletes the selected dumps with their checksum sidecars and nothing else", async () => {
    const h = prunable({ opts: { keep: 2, yes: true } });
    await expect(backupPrune(h.ctx)).resolves.toBe(0);
    expect(files(h.backupDir)).toEqual([N1, `${N1}.sha256`, N2, `${N2}.sha256`].sort());
    const out = h.out.join("\n");
    expect(out).toContain("deleted 3 backup(s)");
    expect(out).not.toMatch(/dry run/i);
  });

  it("--json lists what was deleted and the bytes freed", async () => {
    const h = prunable({ opts: { olderThanDays: 30, yes: true, json: true } });
    await expect(backupPrune(h.ctx)).resolves.toBe(0);
    const report = JSON.parse(h.out.join("\n"));
    expect(report).toMatchObject({
      dryRun: false,
      deleted: [N4, N5],
      freedBytes: 2 * PER_BACKUP,
      errors: [],
    });
    expect(dumps(h.backupDir)).toEqual([N1, N2, N3].sort());
  });

  it("keeps the newest backup even when the rules would take every one", async () => {
    const h = prunable({ opts: { olderThanDays: 1, yes: true } });
    await expect(backupPrune(h.ctx)).resolves.toBe(0);
    expect(files(h.backupDir)).toEqual([N1, `${N1}.sha256`]);
  });

  it("deletes a dump that has no checksum sidecar", async () => {
    const h = prunable({ opts: { keep: 1, yes: true } });
    rmSync(join(h.backupDir, `${N3}.sha256`));
    await expect(backupPrune(h.ctx)).resolves.toBe(0);
    expect(dumps(h.backupDir)).toEqual([N1]);
  });
});

describe("klorn backup prune only touches the CLI's own backups", () => {
  it("leaves foreign files, partial dumps, orphan sidecars and directories alone", async () => {
    const h = prunable({ opts: { keep: 1, yes: true } });
    const foreign = [
      "notes.txt",
      "klorn-20260101T000000Z.dump.partial", // a backup in progress
      "klorn-20260102T000000Z.dump.sha256", // sidecar of a backup that is not here
      "klorn-20260103T000000Z.dump.bak",
      "klorn-20260104T000000Z.DUMP",
      "klorn-latest.dump",
      "other-20260105T000000Z.dump",
      "klorn-20260106T000000Z-Bad_Label.dump",
    ];
    for (const name of foreign) writeFileSync(join(h.backupDir, name), "keep me");
    mkdirSync(join(h.backupDir, "klorn-20260107T000000Z.dump")); // a directory with a backup's name
    writeFileSync(join(h.backupDir, "klorn-20260107T000000Z.dump", "inner"), "keep me");
    await expect(backupPrune(h.ctx)).resolves.toBe(0);
    for (const name of foreign)
      expect(readFileSync(join(h.backupDir, name), "utf8")).toBe("keep me");
    expect(readFileSync(join(h.backupDir, "klorn-20260107T000000Z.dump", "inner"), "utf8")).toBe(
      "keep me",
    );
    expect(dumps(h.backupDir)).toContain(N1);
    expect(existsSync(join(h.backupDir, N5))).toBe(false);
  });

  it("never follows or removes a symlink that is named like a backup", async () => {
    const h = prunable({ opts: { keep: 1, yes: true } });
    const victim = join(h.repoRoot, "precious.txt");
    writeFileSync(victim, "do not delete");
    const link = join(h.backupDir, "klorn-20260108T000000Z.dump");
    symlinkSync(victim, link);
    symlinkSync(victim, `${link}.sha256`);
    await expect(backupPrune(h.ctx)).resolves.toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(lstatSync(`${link}.sha256`).isSymbolicLink()).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("do not delete");
  });

  it("does not delete a backup whose sidecar is a symlink, and exits non-zero", async () => {
    const h = prunable({ opts: { keep: 1, yes: true, json: true } });
    const victim = join(h.repoRoot, "precious.txt");
    writeFileSync(victim, "do not delete");
    const sidecar = join(h.backupDir, `${N3}.sha256`);
    rmSync(sidecar);
    symlinkSync(victim, sidecar);
    await expect(backupPrune(h.ctx)).resolves.toBe(1);
    // N3 stays whole; the other candidates are still pruned.
    expect(existsSync(join(h.backupDir, N3))).toBe(true);
    expect(lstatSync(sidecar).isSymbolicLink()).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("do not delete");
    expect(dumps(h.backupDir)).toEqual([N1, N3].sort());
    const report = JSON.parse(h.out.join("\n"));
    expect(report.deleted).toEqual([N2, N4, N5]);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({ file: sidecar });
    expect(report.errors[0].error).toMatch(/not a regular file/);
  });

  it("refuses a backup directory that other users can write to", async () => {
    const h = prunable({ opts: { keep: 1, yes: true } });
    chmodSync(h.backupDir, 0o777);
    await expect(backupPrune(h.ctx)).rejects.toThrow(/writable by other users/);
    expect(dumps(h.backupDir)).toHaveLength(5);
  });
});

describe("klorn backup prune refuses dangerous directories", () => {
  it("refuses the filesystem root", async () => {
    const h = harness({ opts: { keep: 1, yes: true, backupDir: "/" } });
    await expect(backupPrune(h.ctx)).rejects.toThrow(CliError);
    await expect(backupPrune(h.ctx)).rejects.toThrow(/root|home/);
  });

  it("refuses the home directory, and a symlink that resolves to it", async () => {
    const h = harness({ opts: { keep: 1, yes: true } });
    const home = h.ctx.deps.homeDir;
    writeFileSync(join(home, N5), "not a backup dir, but named like one");
    await expect(backupPrune({ ...h.ctx, backupDir: home })).rejects.toThrow(/home/);
    const link = join(home, "link-to-home");
    symlinkSync(home, link);
    await expect(backupPrune({ ...h.ctx, backupDir: link })).rejects.toThrow(/home/);
    expect(existsSync(join(home, N5))).toBe(true);
  });
});

describe("klorn backup prune reports every failure", () => {
  it("continues past a dump it cannot delete, keeps that backup's sidecar, and exits 1", () => {
    const h = prunable({ opts: { keep: 1, yes: true, json: true } });
    const remove = (path: string) => {
      if (path.endsWith(N3))
        throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      return realRemove(path);
    };
    const report = prune(h.ctx, { remove });
    expect(report.deleted).toEqual([N2, N4, N5]);
    expect(report.errors).toEqual([{ file: join(h.backupDir, N3), error: "EBUSY: resource busy" }]);
    // The pair stays intact: the dump is not left without its checksum.
    expect(existsSync(join(h.backupDir, `${N3}.sha256`))).toBe(true);
    expect(existsSync(join(h.backupDir, N3))).toBe(true);
    expect(report.freedBytes).toBe(3 * PER_BACKUP);
  });

  it("reports a sidecar it cannot delete after its dump is gone", () => {
    const h = prunable({ opts: { keep: 4, yes: true } });
    const remove = (path: string) => {
      if (path.endsWith(`${N5}.sha256`)) throw new Error("EACCES: permission denied");
      return realRemove(path);
    };
    const report = prune(h.ctx, { remove });
    expect(report.deleted).toEqual([]);
    expect(report.errors).toEqual([
      { file: join(h.backupDir, `${N5}.sha256`), error: "EACCES: permission denied" },
    ]);
    expect(existsSync(join(h.backupDir, N5))).toBe(false);
    expect(report.freedBytes).toBe(DUMP_BYTES);
  });

  it("the command exits 1 and prints each error on stderr", async () => {
    const h = prunable({ opts: { keep: 1, yes: true } });
    const sidecar = join(h.backupDir, `${N4}.sha256`);
    rmSync(sidecar);
    symlinkSync(join(h.repoRoot, "elsewhere"), sidecar);
    await expect(backupPrune(h.ctx)).resolves.toBe(1);
    expect(h.err.join("\n")).toContain(sidecar);
    expect(h.out.join("\n")).toContain("deleted 3 backup(s)");
  });

  it("a dry run also exits 1 when it can already see a backup it could not prune", async () => {
    const h = prunable({ opts: { keep: 1 } });
    const sidecar = join(h.backupDir, `${N4}.sha256`);
    rmSync(sidecar);
    symlinkSync(join(h.repoRoot, "elsewhere"), sidecar);
    await expect(backupPrune(h.ctx)).resolves.toBe(1);
    expect(dumps(h.backupDir)).toHaveLength(5);
  });
});

describe("klorn backup prune on the command line", () => {
  async function invoke(argv: string[], input: HarnessInput = {}) {
    const h = harness(input);
    backupDirWith(h);
    const code = await run(argv, h.ctx.deps);
    return { code, h };
  }

  it("needs --keep and/or --older-than: with neither it is a usage error", async () => {
    const { code, h } = await invoke(["backup", "prune", "--yes"]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toMatch(/--keep.*--older-than/);
  });

  it("rejects values that are not positive whole numbers", async () => {
    for (const bad of [
      ["--keep", "0"],
      ["--keep", "-1"],
      ["--keep", "2.5"],
      ["--keep", "all"],
      ["--older-than", "0"],
      ["--older-than", "x"],
    ]) {
      const { code } = await invoke(["backup", "prune", ...bad]);
      expect(code).toBe(2);
    }
  });

  it("does not accept prune's options on other commands", async () => {
    const { code, h } = await invoke(["backup", "list", "--keep", "2"]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toMatch(/--keep does not apply/);
  });

  it("dispatches `backup prune` and defaults to a dry run", async () => {
    const h = harness();
    backupDirWith(h);
    const code = await run(
      ["backup", "prune", "--keep", "2", "--backup-dir", h.backupDir],
      h.ctx.deps,
    );
    expect(code).toBe(0);
    expect(dumps(h.backupDir)).toHaveLength(5);
    expect(h.out.join("\n")).toMatch(/dry run/i);
  });

  it("deletes with --yes through the same entry point", async () => {
    const h = harness();
    backupDirWith(h);
    const code = await run(
      ["backup", "prune", "--keep", "2", "--yes", "--backup-dir", h.backupDir],
      h.ctx.deps,
    );
    expect(code).toBe(0);
    expect(dumps(h.backupDir)).toEqual([N1, N2].sort());
  });

  it("raises a UsageError from the handler when no rule is given", async () => {
    const h = prunable();
    await expect(backupPrune(h.ctx)).rejects.toThrow(UsageError);
  });
});
