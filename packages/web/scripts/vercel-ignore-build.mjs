#!/usr/bin/env node
/**
 * Vercel "Ignored Build Step" for the klorn-web project (packages/web/vercel.json
 * `ignoreCommand`). Exit 0 = skip this deployment's build, exit 1 = build.
 *
 * It skips only when nothing the web build reads changed between the last
 * successful deployment of this branch (VERCEL_GIT_PREVIOUS_SHA) and HEAD.
 * Comparing against HEAD^ instead would lose a skipped web commit for good once
 * an API-only commit lands on top of it.
 *
 * It fails OPEN: whenever it cannot prove the web is unchanged (no previous
 * SHA, that commit missing from Vercel's depth-10 clone, HEAD not the commit
 * being deployed, a redeploy of the same commit, an unresolvable workspace
 * dependency, any git error) it builds.
 *
 * Web inputs: the Root Directory this runs in (packages/web, which also holds
 * vercel.json and this script), every workspace package it depends on,
 * transitively, read from the package.json files, and the root files that shape
 * the install. A relative import from packages/web into another package would
 * not be tracked; there are none (web reaches other packages only through
 * workspace dependencies).
 *
 * Redeploys: a dashboard Redeploy of a deployment this step cancelled is
 * skipped again, because its commit changed no web input. To rebuild for an env
 * var change, redeploy the current production deployment (its commit is the
 * previous SHA, so it builds) or untick "Use project's Ignore Build Step".
 *
 * Vercel counts a deployment cancelled by this step toward the Hobby
 * 100-deployments-per-day quota; it saves build time, not quota.
 *
 * Run: node scripts/vercel-ignore-build.mjs   (from packages/web; Vercel does)
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";

const SKIP = 0;
const BUILD = 1;
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024;
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const LOCAL_PROTOCOLS = ["file:", "link:", "portal:"];
const ROOT_INPUTS = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  ".pnpmfile.cjs",
  ".vercelignore",
  "vercel.json",
];

function git(args, cwd) {
  return execFileSync("git", ["--literal-pathspecs", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_LIMIT,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function readManifest(top, dir) {
  return JSON.parse(readFileSync(posix.join(top, dir, "package.json"), "utf8"));
}

/** package name -> directory, for every tracked package.json except the root one. */
function packageDirsByName(top) {
  const byName = new Map();
  const manifests = git(["ls-files", "-z"], top)
    .split("\0")
    .filter((file) => file.endsWith("/package.json"));
  for (const file of manifests) {
    const dir = posix.dirname(file);
    const { name } = readManifest(top, dir);
    if (!name) continue;
    byName.set(name, byName.has(name) ? null : dir);
  }
  return byName;
}

function workspaceDepNames(manifest, dir) {
  const names = [];
  for (const field of DEP_FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (typeof spec !== "string") continue;
      if (LOCAL_PROTOCOLS.some((protocol) => spec.startsWith(protocol))) {
        throw new Error(`${dir}: local dependency ${name}@${spec} is not resolved by this script`);
      }
      if (spec.startsWith("workspace:")) names.push(name);
    }
  }
  return names;
}

/** The app directory plus every workspace package it depends on, transitively. */
function webInputDirs(top, appDir) {
  const byName = packageDirsByName(top);
  const dirs = new Set([appDir]);
  const queue = [appDir];
  while (queue.length > 0) {
    const dir = queue.shift();
    for (const name of workspaceDepNames(readManifest(top, dir), dir)) {
      const depDir = byName.get(name);
      if (!depDir)
        throw new Error(`${dir}: cannot map workspace dependency ${name} to one package`);
      if (dirs.has(depDir)) continue;
      dirs.add(depDir);
      queue.push(depDir);
    }
  }
  return [...dirs].sort();
}

/** Returns [SKIP or BUILD, reason]; never throws. */
function decide({ cwd, previousSha, commitSha }) {
  try {
    if (!previousSha)
      return [BUILD, "no VERCEL_GIT_PREVIOUS_SHA (first deployment of this branch)"];
    if (!SHA_PATTERN.test(previousSha))
      return [BUILD, "VERCEL_GIT_PREVIOUS_SHA is not a full commit SHA"];
    const top = git(["rev-parse", "--show-toplevel"], cwd);
    const appDir = git(["rev-parse", "--show-prefix"], cwd).replace(/\/$/, "");
    if (!appDir) return [BUILD, "not running inside the app's Root Directory"];
    const head = git(["rev-parse", "--verify", "HEAD^{commit}"], top);
    if (commitSha && commitSha.toLowerCase() !== head) {
      return [BUILD, `HEAD ${head} is not VERCEL_GIT_COMMIT_SHA ${commitSha}`];
    }
    let previous;
    try {
      previous = git(["rev-parse", "--verify", "--quiet", `${previousSha}^{commit}`], top);
    } catch {
      return [BUILD, `previous deployment ${previousSha} is not in this clone`];
    }
    if (previous === head) return [BUILD, "HEAD is the previous deployment's commit (redeploy)"];
    const paths = [...webInputDirs(top, appDir), ...ROOT_INPUTS];
    const changed = git(["diff", "--name-only", previous, head, "--", ...paths], top);
    if (changed) return [BUILD, `web inputs changed since ${previous.slice(0, 12)}:\n${changed}`];
    return [
      SKIP,
      `no web input changed since ${previous.slice(0, 12)} (checked: ${paths.join(", ")})`,
    ];
  } catch (error) {
    return [BUILD, `could not decide, building: ${error instanceof Error ? error.message : error}`];
  }
}

// No import guard on purpose: a guard that fails to match would exit 0, which
// Vercel reads as "skip". The test runs this file as a process, like Vercel.
const [code, reason] = decide({
  cwd: process.cwd(),
  previousSha: (process.env.VERCEL_GIT_PREVIOUS_SHA ?? "").trim(),
  commitSha: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").trim(),
});
console.log(`[vercel-ignore-build] ${code === SKIP ? "SKIP" : "BUILD"}: ${reason}`);
process.exit(code);
