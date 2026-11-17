#!/usr/bin/env node
/**
 * Supply-chain guard: every third-party GitHub Action must be pinned to a full
 * 40-character commit SHA, with the human-readable version as a trailing
 * comment (`uses: actions/checkout@<sha> # v7.0.1`).
 *
 * A tag or branch (`@v7`, `@main`) is mutable: whoever controls the upstream
 * repo can move it under a workflow that holds our release secrets. A SHA
 * cannot move. Dependabot's `github-actions` ecosystem keeps SHA pins current
 * and rewrites the version comment, so pinning does not freeze us.
 *
 * Local actions (`./...`) are in this repo already and are exempt. Container
 * references (`docker://image@sha256:<64 hex>`) must carry a digest.
 *
 * Usage: node check-actions-pinned.mjs [workflowsDir]   (default .github/workflows)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const USES = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/;
const SHA_PIN = /^[^@\s]+@[0-9a-f]{40}$/;
const DIGEST_PIN = /^docker:\/\/\S+@sha256:[0-9a-f]{64}$/;
const VERSION_COMMENT = /^\s*#\s*\S+/;

/** Returns human-readable violations for one workflow file's text. */
export function findViolations(file, text) {
  const violations = [];
  text.split("\n").forEach((line, index) => {
    const match = USES.exec(line);
    if (!match) return;
    const [, ref, rest] = match;
    if (ref.startsWith("./")) return;
    const where = `${file}:${index + 1}`;
    if (ref.startsWith("docker://")) {
      if (!DIGEST_PIN.test(ref)) {
        violations.push(`${where}  ${ref} — pin the image to a sha256 digest`);
      }
      return;
    }
    if (!SHA_PIN.test(ref)) {
      violations.push(`${where}  ${ref} — pin to a full commit SHA (mutable refs can be moved)`);
      return;
    }
    if (!VERSION_COMMENT.test(rest)) {
      violations.push(`${where}  ${ref} — add the version as a trailing comment, e.g. "# v1.2.3"`);
    }
  });
  return violations;
}

function main() {
  const dir = process.argv[2] ?? ".github/workflows";
  const files = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));
  const violations = files.flatMap((name) =>
    findViolations(join(dir, name), readFileSync(join(dir, name), "utf8")),
  );
  if (violations.length > 0) {
    console.error(`Unpinned GitHub Actions (${violations.length}):`);
    for (const violation of violations) console.error(`  ${violation}`);
    process.exit(1);
  }
  console.log(`All actions in ${files.length} workflow files are pinned to commit SHAs.`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
