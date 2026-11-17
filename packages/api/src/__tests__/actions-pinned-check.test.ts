/**
 * .github/scripts/check-actions-pinned.mjs (the "Actions pinned to SHAs" Lint
 * step in ci.yml).
 *
 * A SHA pin freezes an action's code, not what that code downloads. The
 * trufflehog action runs `docker run "${IMAGE}:${VERSION}"` with `version`
 * defaulting to `latest`, so the scanner that sees every commit kept changing
 * under a pinned action. The check requires that input to name the release the
 * pin's comment names, by image digest.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const SCRIPT = join(repoRoot, ".github/scripts/check-actions-pinned.mjs");
const scratch = mkdtempSync(join(tmpdir(), "actions-pinned-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PIN = "trufflesecurity/trufflehog@3bd2b5887eb0efb8fa18bfd1d296032924e4ffdc # v3.99.9";
const DIGEST = `sha256:${"2e".repeat(32)}`;

let fixture = 0;
function check(stepWith: string): { status: number | null; output: string } {
  const dir = join(scratch, `case-${fixture++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "security.yml"),
    [
      "jobs:",
      "  security:",
      "    steps:",
      "      - name: Scan for hardcoded secrets",
      `        uses: ${PIN}`,
      stepWith,
      "      - name: Next step",
      "        run: echo next",
      "",
    ].join("\n"),
  );
  const run = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe("check-actions-pinned: an action that pulls a container image by tag", () => {
  it.each([
    [
      "no version input (defaults to latest)",
      "        with:\n          extra_args: --only-verified",
    ],
    ["no with block at all", ""],
    ["version: latest", "        with:\n          version: latest"],
    ["a tag without a digest", "        with:\n          version: 3.99.9"],
    ["a release other than the pinned one", `        with:\n          version: 3.99.8@${DIGEST}`],
    [
      "a version input on the NEXT step, not this one",
      "        with:\n          extra_args: --only-verified\n      - uses: ./local\n        with:\n          version: 3.99.9@" +
        DIGEST,
    ],
  ])("fails on %s", (_name, stepWith) => {
    const { status, output } = check(stepWith);
    expect(status).toBe(1);
    expect(output).toContain("trufflesecurity/trufflehog");
    expect(output).toContain("version");
  });

  it("passes on the pinned release by digest", () => {
    const { status, output } = check(
      `        with:\n          extra_args: --only-verified\n          version: 3.99.9@${DIGEST}`,
    );
    expect(output).toContain("pinned");
    expect(status).toBe(0);
  });

  it("passes on this repository's workflows", () => {
    const run = spawnSync(process.execPath, [SCRIPT, join(repoRoot, ".github/workflows")], {
      encoding: "utf8",
    });
    expect(`${run.stdout}${run.stderr}`).toContain("pinned");
    expect(run.status).toBe(0);
  });
});
