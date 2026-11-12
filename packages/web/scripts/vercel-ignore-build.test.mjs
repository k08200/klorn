/**
 * Tests for vercel-ignore-build.mjs, run as a process the way Vercel runs it:
 * cwd = the Root Directory (packages/web), VERCEL_GIT_PREVIOUS_SHA and
 * VERCEL_GIT_COMMIT_SHA set, exit 0 = skip, 1 = build. The fixture is a
 * throwaway git repo with the monorepo's shape, so the test needs no history
 * from the real checkout.
 *
 * Run: node --test packages/web/scripts/vercel-ignore-build.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./vercel-ignore-build.mjs", import.meta.url));
const SKIP = 0;
const BUILD = 1;
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
// Root files that shape the install; each must force a build on its own.
const ROOT_INPUTS = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  ".pnpmfile.cjs",
  ".vercelignore",
  "vercel.json",
];

let root;
let repo;
const sha = {};

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function headOf(cwd) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, env: GIT_ENV, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function write(file, content) {
  const path = join(repo, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

function commit(name, files) {
  for (const [file, content] of Object.entries(files)) write(file, content);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", name);
  sha[name] = git(repo, "rev-parse", "HEAD");
}

/** Starts a throwaway branch at `from` so a test's commits don't leak into others. */
function branchFrom(from) {
  git(repo, "checkout", "-q", "--detach", from);
}

function run({ head, previousSha, commitSha, cwd = join(repo, "packages/web") }) {
  if (head) git(repo, "checkout", "-q", "--detach", head);
  const env = {
    ...GIT_ENV,
    VERCEL_GIT_PREVIOUS_SHA: previousSha,
    VERCEL_GIT_COMMIT_SHA: commitSha ?? headOf(cwd),
  };
  const result = spawnSync(process.execPath, [SCRIPT], { cwd, env, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function expectDecision(expected, options) {
  const { status, output } = run(options);
  assert.equal(status, expected, output);
}

const webManifest = {
  name: "@klorn/web",
  dependencies: { next: "^15.5.27" },
  devDependencies: { "@klorn/contract": "workspace:*" },
  peerDependencies: { "@klorn/peer": "workspace:*" },
};

before(() => {
  root = mkdtempSync(join(tmpdir(), "vercel-ignore-build-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  commit("base", {
    "package.json": { name: "klorn", private: true },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "docs/notes.md": "notes\n",
    ".github/workflows/ci.yml": "name: CI\n",
    "packages/web/package.json": webManifest,
    "packages/web/vercel.json": { framework: "nextjs" },
    "packages/web/src/page.tsx": "export default 1;\n",
    "packages/contract/package.json": {
      name: "@klorn/contract",
      dependencies: { "@klorn/shared": "workspace:^" },
      optionalDependencies: { "@klorn/opt": "workspace:*" },
    },
    "packages/contract/src/index.ts": "export type A = 1;\n",
    "packages/shared/package.json": { name: "@klorn/shared" },
    "packages/shared/src/index.ts": "export type S = 1;\n",
    "packages/opt/package.json": { name: "@klorn/opt" },
    "packages/opt/src/index.ts": "export type O = 1;\n",
    "packages/peer/package.json": { name: "@klorn/peer" },
    "packages/peer/src/index.ts": "export type P = 1;\n",
    "packages/api/package.json": {
      name: "@klorn/api",
      dependencies: { "@klorn/contract": "workspace:*" },
    },
    "packages/api/src/server.ts": "export const port = 1;\n",
  });
  commit("api", { "packages/api/src/server.ts": "export const port = 2;\n" });
  commit("docs-ci", { "docs/notes.md": "more\n", ".github/workflows/ci.yml": "name: CI2\n" });
  commit("web", { "packages/web/src/page.tsx": "export default 2;\n" });
  commit("api-after-web", { "packages/api/src/server.ts": "export const port = 3;\n" });
  commit("contract", { "packages/contract/src/index.ts": "export type A = 2;\n" });
  commit("shared", { "packages/shared/src/index.ts": "export type S = 2;\n" });
  commit("opt", { "packages/opt/src/index.ts": "export type O = 2;\n" });
  commit("peer", { "packages/peer/src/index.ts": "export type P = 2;\n" });
  commit("web-vercel-json", { "packages/web/vercel.json": { framework: "nextjs", git: {} } });
  for (const file of ROOT_INPUTS) commit(`root:${file}`, { [file]: `changed ${file}\n` });
  git(repo, "mv", "packages/web/src/page.tsx", "packages/api/src/page.tsx");
  commit("move-out-of-web", {});
  commit("clean", { "packages/api/src/server.ts": "export const port = 4;\n" });
  git(repo, "branch", "clean");
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test("skips an API-only change", () => {
  expectDecision(SKIP, { head: sha.api, previousSha: sha.base });
});

test("skips a docs and .github change", () => {
  expectDecision(SKIP, { head: sha["docs-ci"], previousSha: sha.api });
});

test("builds a packages/web change", () => {
  expectDecision(BUILD, { head: sha.web, previousSha: sha["docs-ci"] });
});

test("builds an API commit that lands on a skipped web commit (diffs from the previous deployment, not HEAD^)", () => {
  expectDecision(BUILD, { head: sha["api-after-web"], previousSha: sha["docs-ci"] });
  expectDecision(SKIP, { head: sha["api-after-web"], previousSha: sha.web });
});

test("builds a change to each workspace dependency of web, direct or transitive, in any dependency field", () => {
  expectDecision(BUILD, { head: sha.contract, previousSha: sha["api-after-web"] });
  expectDecision(BUILD, { head: sha.shared, previousSha: sha.contract });
  expectDecision(BUILD, { head: sha.opt, previousSha: sha.shared });
  expectDecision(BUILD, { head: sha.peer, previousSha: sha.opt });
});

test("builds a change to packages/web/vercel.json", () => {
  expectDecision(BUILD, { head: sha["web-vercel-json"], previousSha: sha.peer });
});

test("builds a change to each root install input", () => {
  let previous = sha["web-vercel-json"];
  for (const file of ROOT_INPUTS) {
    const head = sha[`root:${file}`];
    const { status, output } = run({ head, previousSha: previous });
    assert.equal(status, BUILD, `${file}: ${output}`);
    previous = head;
  }
});

test("builds when a file moves out of packages/web", () => {
  expectDecision(BUILD, {
    head: sha["move-out-of-web"],
    previousSha: sha[`root:${ROOT_INPUTS.at(-1)}`],
  });
});

test("compares trees, so a previous deployment that is not an ancestor of HEAD still works", () => {
  branchFrom(sha.base);
  commit("side-web", { "packages/web/src/page.tsx": "export default 9;\n" });
  expectDecision(BUILD, { head: sha.api, previousSha: sha["side-web"] });
  branchFrom(sha.base);
  commit("side-docs", { "docs/notes.md": "side\n" });
  expectDecision(SKIP, { head: sha.api, previousSha: sha["side-docs"] });
});

test("builds when VERCEL_GIT_PREVIOUS_SHA is empty", () => {
  expectDecision(BUILD, { head: sha.api, previousSha: "" });
});

test("builds when VERCEL_GIT_PREVIOUS_SHA is not in the repo", () => {
  expectDecision(BUILD, { head: sha.api, previousSha: "0123456789abcdef0123456789abcdef01234567" });
});

test("builds when VERCEL_GIT_PREVIOUS_SHA is not a full commit SHA", () => {
  expectDecision(BUILD, { head: sha.api, previousSha: sha.base.slice(0, 12) });
  expectDecision(BUILD, { head: sha.api, previousSha: "HEAD~1" });
  expectDecision(BUILD, { head: sha.api, previousSha: "--output=/tmp/x" });
});

test("builds when HEAD is not VERCEL_GIT_COMMIT_SHA", () => {
  expectDecision(BUILD, { head: sha.api, previousSha: sha.base, commitSha: sha["docs-ci"] });
});

test("builds a redeploy of the previous deployment's own commit", () => {
  expectDecision(BUILD, { head: sha.api, previousSha: sha.api });
});

test("builds when not run from inside the app directory", () => {
  expectDecision(BUILD, { head: sha.api, previousSha: sha.base, cwd: repo });
  expectDecision(BUILD, { head: sha.api, previousSha: sha.base, cwd: root });
});

test("builds when a workspace dependency cannot be mapped to exactly one package", () => {
  branchFrom(sha.clean);
  commit("missing-dep", {
    "packages/web/package.json": {
      ...webManifest,
      devDependencies: { "@klorn/contract": "workspace:*", "@klorn/gone": "workspace:*" },
    },
  });
  commit("api-after-missing", { "packages/api/src/server.ts": "export const port = 5;\n" });
  expectDecision(BUILD, { head: sha["api-after-missing"], previousSha: sha["missing-dep"] });

  branchFrom(sha.clean);
  commit("duplicate-name", { "apps/copy/package.json": { name: "@klorn/contract" } });
  commit("api-after-duplicate", { "packages/api/src/server.ts": "export const port = 6;\n" });
  expectDecision(BUILD, { head: sha["api-after-duplicate"], previousSha: sha["duplicate-name"] });
});

test("builds when web has a file:/link: dependency it cannot track", () => {
  branchFrom(sha.clean);
  commit("link-dep", {
    "packages/web/package.json": { ...webManifest, dependencies: { x: "link:../x" } },
  });
  commit("api-after-link", { "packages/api/src/server.ts": "export const port = 7;\n" });
  expectDecision(BUILD, { head: sha["api-after-link"], previousSha: sha["link-dep"] });
});

test("builds in a shallow clone that lacks the previous deployment's commit", () => {
  const clone = join(root, "shallow");
  git(root, "clone", "-q", "--depth", "1", "--branch", "clean", `file://${repo}`, clone);
  assert.equal(git(clone, "rev-parse", "--is-shallow-repository"), "true");
  const { status, output } = run({ previousSha: sha.base, cwd: join(clone, "packages/web") });
  assert.equal(status, BUILD, output);
  assert.match(output, /is not in this clone/);
});
