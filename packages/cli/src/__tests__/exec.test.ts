import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { redact, spawnRunner, tail } from "../lib/exec.js";

// These run real (tiny) node children: the runner is the one module that owns
// child_process, so it is tested against the real thing rather than a mock.
const node = process.execPath;
const scratch = () => mkdtempSync(join(tmpdir(), "klorn-cli-exec-"));

describe("spawnRunner", () => {
  it("captures stdout, stderr and the exit code", async () => {
    const result = await spawnRunner({
      cmd: node,
      args: ["-e", "process.stdout.write('out');process.stderr.write('err');process.exit(3)"],
    });
    expect(result).toEqual({ code: 3, stdout: "out", stderr: "err" });
  });

  it("passes extra env to the child without putting it in argv", async () => {
    const result = await spawnRunner({
      cmd: node,
      args: ["-e", "process.stdout.write(process.env.KLORN_TEST_SECRET ?? 'unset')"],
      env: { KLORN_TEST_SECRET: "from-env" },
    });
    expect(result.stdout).toBe("from-env");
  });

  it("removes inherited variables listed in unsetEnv", async () => {
    process.env.KLORN_TEST_INHERITED = "leak";
    try {
      const result = await spawnRunner({
        cmd: node,
        args: ["-e", "process.stdout.write(process.env.KLORN_TEST_INHERITED ?? 'unset')"],
        unsetEnv: ["KLORN_TEST_INHERITED"],
      });
      expect(result.stdout).toBe("unset");
    } finally {
      delete process.env.KLORN_TEST_INHERITED;
    }
  });

  it("streams stdout into a new 0600 file", async () => {
    const out = join(scratch(), "dump.bin");
    const result = await spawnRunner(
      { cmd: node, args: ["-e", "process.stdout.write('archive-bytes')"] },
      { stdoutFile: out },
    );
    expect(result.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("archive-bytes");
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it("refuses to overwrite an existing stdout file", async () => {
    const out = join(scratch(), "exists.bin");
    writeFileSync(out, "keep me");
    await expect(
      spawnRunner({ cmd: node, args: ["-e", "1"] }, { stdoutFile: out }),
    ).rejects.toThrow(/EEXIST/);
    expect(readFileSync(out, "utf8")).toBe("keep me");
  });

  it("feeds a file to stdin", async () => {
    const input = join(scratch(), "in.txt");
    writeFileSync(input, "restore-me");
    const result = await spawnRunner(
      {
        cmd: node,
        args: [
          "-e",
          "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s.toUpperCase()))",
        ],
      },
      { stdinFile: input },
    );
    expect(result.stdout).toBe("RESTORE-ME");
  });

  it("reports a missing executable as exit 127 instead of throwing", async () => {
    const result = await spawnRunner({ cmd: "klorn-definitely-not-a-command", args: [] });
    expect(result.code).toBe(127);
    expect(result.stderr).toMatch(/not found/);
  });

  it("kills a child that outlives its timeout", async () => {
    const result = await spawnRunner(
      { cmd: node, args: ["-e", "setTimeout(()=>{}, 60000)"] },
      { timeoutMs: 200 },
    );
    expect(result.code).toBe(124);
  });

  it("never runs through a shell", async () => {
    const result = await spawnRunner({
      cmd: node,
      args: ["-e", "process.stdout.write(process.argv[1])", "$(echo injected);rm -rf /"],
    });
    expect(result.stdout).toBe("$(echo injected);rm -rf /");
  });
});

describe("redact", () => {
  it("replaces every occurrence of each secret, and the URL-encoded form", () => {
    expect(redact("auth failed: p@ss and p%40ss", ["p@ss"])).toBe("auth failed: *** and ***");
  });

  it("ignores empty and very short secrets that would shred the text", () => {
    expect(redact("abc", ["", "a"])).toBe("abc");
  });
});

describe("tail", () => {
  it("keeps the last lines of long output", () => {
    expect(tail("1\n2\n3\n4\n", 2)).toBe("3\n4");
  });
});
