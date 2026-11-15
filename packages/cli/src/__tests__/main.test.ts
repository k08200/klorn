import { describe, expect, it } from "vitest";
import { parseCli } from "../args.js";
import { UsageError } from "../errors.js";
import { run } from "../main.js";
import { HEALTH_OK, harness, jsonResponse } from "./helpers.js";

describe("parseCli", () => {
  it("reads the command words and options", () => {
    const parsed = parseCli([
      "backup",
      "restore",
      "klorn-20261101T000000Z.dump",
      "--target",
      "compose",
      "--yes",
      "--no-backup",
      "--i-know",
      "--timeout",
      "30",
    ]);
    expect(parsed.words).toEqual(["backup", "restore", "klorn-20261101T000000Z.dump"]);
    expect(parsed.opts).toMatchObject({
      target: "compose",
      yes: true,
      noBackup: true,
      iKnow: true,
      timeoutSec: 30,
    });
  });

  it("rejects unknown flags and bad numbers as usage errors", () => {
    expect(() => parseCli(["doctor", "--frobnicate"])).toThrow(UsageError);
    expect(() => parseCli(["up", "--timeout", "soon"])).toThrow(UsageError);
  });
});

/** run() with a harness context: exercise dispatch and exit codes without processes. */
async function invoke(argv: string[], input: Parameters<typeof harness>[0] = {}) {
  const h = harness(input);
  const code = await run(argv, h.ctx.deps);
  return { code, h };
}

describe("run", () => {
  it("prints usage for help and exits 0", async () => {
    const { code, h } = await invoke(["help"]);
    expect(code).toBe(0);
    expect(h.out.join("\n")).toMatch(/klorn doctor/);
    expect(h.out.join("\n")).toMatch(/klorn backup restore/);
  });

  it("exits 2 on an unknown command", async () => {
    const { code, h } = await invoke(["deploy"]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toMatch(/unknown command/);
  });

  it("exits 2 on an extra argument", async () => {
    const { code } = await invoke(["doctor", "now"]);
    expect(code).toBe(2);
  });

  it("rejects an option that belongs to another command instead of ignoring it", async () => {
    const { code, h } = await invoke(["backup", "create", "--target", "env:OTHER_DB"]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toMatch(/--target does not apply/);
    expect(h.calls).toEqual([]);
    expect((await invoke(["backup", "restore", "x.dump", "--db", "compose"])).code).toBe(2);
  });

  it("treats prototype names as unknown commands", async () => {
    for (const word of ["constructor", "__proto__", "toString"]) {
      expect((await invoke([word])).code).toBe(2);
    }
  });

  it("exits 1 with the message on an operational failure", async () => {
    const { code, h } = await invoke([
      "backup",
      "restore",
      "missing.dump",
      "--target",
      "compose",
      "--yes",
    ]);
    expect(code).toBe(1);
    expect(h.err.join("\n")).toMatch(/no such backup/);
  });

  it("dispatches `migrate status`", async () => {
    const { code, h } = await invoke(["migrate", "status", "--json"], {
      handler: (call) => {
        const sql = call.argv.at(-1) ?? "";
        if (sql.includes("to_regclass")) return { stdout: "f" };
        return undefined;
      },
    });
    expect(code).toBe(0);
    expect(JSON.parse(h.out.join("\n"))).toMatchObject({ upToDate: true, appliedCount: 0 });
  });

  it("dispatches `up`", async () => {
    const { code } = await invoke(["up"], { fetch: () => jsonResponse(HEALTH_OK) });
    expect(code).toBe(0);
  });
});
