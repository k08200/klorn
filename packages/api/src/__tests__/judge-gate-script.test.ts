/**
 * scripts/judge-gate.sh decides the judge accuracy gate in CI (eval.yml) and
 * the weekly canary (judge-canary.yml). The judge (Claude Haiku 5.5) takes no
 * temperature, so the script re-runs once on a floor failure (exit 2) and
 * retries once on an outage (exit 3). These tests pin that decision table
 * with a stub `npx` that replays scripted poc-accuracy exit codes — no LLM.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../../scripts/judge-gate.sh");

const FAKE_NPX = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
code=$(head -n 1 "$FAKE_CODES")
tail -n +2 "$FAKE_CODES" > "$FAKE_CODES.next" && mv "$FAKE_CODES.next" "$FAKE_CODES"
exit "\${code:-0}"
`;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runGate(codes: number[], evalSet = "eval/judge-eval-set.json") {
  const dir = mkdtempSync(join(tmpdir(), "judge-gate-"));
  dirs.push(dir);
  const npx = join(dir, "npx");
  writeFileSync(npx, FAKE_NPX);
  chmodSync(npx, 0o755);
  const codesFile = join(dir, "codes");
  writeFileSync(codesFile, `${codes.join("\n")}\n`);
  const log = join(dir, "calls");
  writeFileSync(log, "");

  const result = spawnSync("bash", [SCRIPT, evalSet], {
    encoding: "utf8",
    env: {
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      FAKE_CODES: codesFile,
      FAKE_LOG: log,
      JUDGE_GATE_RETRY_PAUSE_SECONDS: "0",
    },
  });
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { exit: result.status, calls, out: `${result.stdout}${result.stderr}` };
}

describe("judge-gate.sh decision table", () => {
  it.each([
    { codes: [0], exit: 0, runs: 1, why: "a pass is final" },
    { codes: [2, 0], exit: 0, runs: 2, why: "one floor failure, re-run passes" },
    { codes: [2, 2], exit: 2, runs: 2, why: "a floor failure on both runs fails" },
    { codes: [3, 0], exit: 0, runs: 2, why: "an outage is retried once" },
    { codes: [3, 3], exit: 3, runs: 2, why: "a second outage fails without a floor re-run" },
    { codes: [3, 2, 0], exit: 0, runs: 3, why: "outage, then floor failure, then pass" },
    {
      codes: [2, 3, 3],
      exit: 3,
      runs: 3,
      why: "floor failure, then the re-run hits an outage twice",
    },
    { codes: [2, 3, 2], exit: 2, runs: 3, why: "the re-run's outage retry also misses a floor" },
    { codes: [1], exit: 1, runs: 1, why: "a crash passes through without a re-run" },
    { codes: [2, 1], exit: 1, runs: 2, why: "a crash on the re-run fails closed" },
  ])("$codes → exit $exit after $runs run(s): $why", ({ codes, exit, runs }) => {
    const result = runGate(codes);
    expect(result.exit).toBe(exit);
    expect(result.calls).toHaveLength(runs);
  });

  it("scores the eval set it was given through poc-accuracy", () => {
    const { calls } = runGate([0], "eval/real-eval-set.json");
    expect(calls[0]).toBe(
      "tsx scripts/poc-accuracy.ts --in=eval/real-eval-set.json --concurrency=2 --delay=500",
    );
  });

  it("says in the log when a pass needed the re-run", () => {
    const { out } = runGate([2, 0]);
    expect(out).toMatch(/::warning::A floor failed on the first run/);
    expect(out).toMatch(/::warning::The re-run passed/);
  });

  it("refuses to run without an eval set", () => {
    const result = spawnSync("bash", [SCRIPT], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/usage/);
  });
});
