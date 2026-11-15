/**
 * The image publish refuses a tag that is not the API's package version
 * (.github/scripts/check-release-version.mjs, run by publish-image.yml).
 *
 * `klorn upgrade 0.4.1` (packages/cli) pulls the images tagged 0.4.1 and waits
 * for /api/health to report 0.4.1, and the API reports the version in
 * packages/api/package.json. An image published under a tag that differs from
 * that version can never finish an upgrade: the wait times out every time.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const SCRIPT = join(repoRoot, ".github/scripts/check-release-version.mjs");
const WORKFLOW = join(repoRoot, ".github/workflows/publish-image.yml");
const scratch = mkdtempSync(join(tmpdir(), "release-version-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function packageAt(version: string): string {
  const path = join(scratch, `package-${version}.json`);
  writeFileSync(path, JSON.stringify({ name: "@klorn/api", version }));
  return path;
}

function check(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe("check-release-version.mjs", () => {
  it("passes when the tag is v + the package version", () => {
    expect(check(["v0.4.1", "--package", packageAt("0.4.1")]).status).toBe(0);
    expect(check(["v1.0.0-rc.1", "--package", packageAt("1.0.0-rc.1")]).status).toBe(0);
  });

  it("fails, naming both versions, when they differ", () => {
    const result = check(["v0.4.2", "--package", packageAt("0.4.1")]);
    expect(result.status).toBe(1);
    expect(result.out).toContain("::error");
    expect(result.out).toContain("0.4.2");
    expect(result.out).toContain("0.4.1");
  });

  it("fails on a tag that is not v<version>, an empty tag, or none at all", () => {
    const pkg = packageAt("0.4.1");
    expect(check(["0.4.1", "--package", pkg]).status).toBe(1);
    expect(check(["v0.4.1-hotfix", "--package", pkg]).status).toBe(1);
    expect(check(["", "--package", pkg]).status).toBe(1);
    expect(check(["--package", pkg]).status).toBe(1);
  });

  it("reads the tag from GITHUB_REF_NAME when none is given", () => {
    const pkg = packageAt("0.4.1");
    expect(check(["--package", pkg], { GITHUB_REF_NAME: "v0.4.1" }).status).toBe(0);
    expect(check(["--package", pkg], { GITHUB_REF_NAME: "v9.9.9" }).status).toBe(1);
  });

  it("checks packages/api/package.json by default, the file the API's health reads", () => {
    const { version } = JSON.parse(
      readFileSync(join(repoRoot, "packages/api/package.json"), "utf8"),
    ) as { version: string };
    expect(check([`v${version}`]).status).toBe(0);
    expect(check(["v0.0.0-not-this"]).status).toBe(1);
  });
});

describe("publish-image.yml", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  it("runs the check on tag builds, in a job every publish waits for", () => {
    expect(workflow).toMatch(
      /\n {2}version:\n[\s\S]*?if: github\.ref_type == 'tag'\n\s+run: node \.github\/scripts\/check-release-version\.mjs "\$GITHUB_REF_NAME"/,
    );
    expect(workflow).toMatch(/\n {2}publish:\n {4}needs: version\n/);
  });
});
