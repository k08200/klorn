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
 * A SHA pin freezes the action's own code, not an image that code pulls by a
 * tag from an input: trufflehog's action runs `docker run "${IMAGE}:${VERSION}"`
 * with `version` defaulting to `latest`. For the actions in IMAGE_TAG_INPUTS
 * that input must name the release the pin's comment names, by digest
 * (`version: 3.99.9@sha256:<64 hex>`), so a Dependabot bump of the pin fails
 * here until the image is bumped with it.
 *
 * Usage: node check-actions-pinned.mjs [workflowsDir]   (default .github/workflows)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const USES = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/;
const SHA_PIN = /^[^@\s]+@[0-9a-f]{40}$/;
const DIGEST_PIN = /^docker:\/\/\S+@sha256:[0-9a-f]{64}$/;
const VERSION_COMMENT = /^\s*#\s*\S+/;
const COMMENT_RELEASE = /#\s*v?(\d+\.\d+\.\d+)\b/;
const DIGEST_RELEASE = /^(\d+\.\d+\.\d+)@sha256:[0-9a-f]{64}$/;

/** Action repo → the input whose value becomes the tag of the image it runs. */
const IMAGE_TAG_INPUTS = { "trufflesecurity/trufflehog": "version" };

/**
 * The value of input `name` under the `with:` of the step whose `uses:` is on
 * line `usesIndex`, or undefined. The step's keys sit at the column of `uses:`;
 * the step ends at the first line indented less.
 */
function stepInput(lines, usesIndex, name) {
  const keyColumn = lines[usesIndex].indexOf("uses:");
  let inWith = false;
  for (let i = usesIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const column = line.search(/\S/);
    if (column < keyColumn) return undefined;
    if (column === keyColumn) {
      inWith = /^with:\s*$/.test(line.trim());
      continue;
    }
    const input = inWith ? /^([\w-]+):\s*(.*?)\s*(?:#.*)?$/.exec(line.trim()) : null;
    if (input && input[1] === name) return input[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return undefined;
}

/** A violation when an image-pulling action's tag input does not pin its release by digest. */
function imageTagViolation(lines, usesIndex, ref, rest) {
  // GitHub owner/repo names are case-insensitive in `uses:`.
  const repo = ref.split("@")[0].toLowerCase();
  const input = IMAGE_TAG_INPUTS[repo];
  if (!input) return null;
  const release = COMMENT_RELEASE.exec(rest)?.[1];
  const value = stepInput(lines, usesIndex, input);
  const pinned = value === undefined ? null : DIGEST_RELEASE.exec(value);
  if (release && pinned?.[1] === release) return null;
  const expected = `${release ?? "<release>"}@sha256:<digest>`;
  return `${ref} — set \`with: ${input}: ${expected}\` (got ${value ?? "nothing, which defaults to latest"}): the pin freezes the action, not the image it pulls`;
}

/** Returns human-readable violations for one workflow file's text. */
export function findViolations(file, text) {
  const violations = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
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
      return;
    }
    const imageTag = imageTagViolation(lines, index, ref, rest);
    if (imageTag) violations.push(`${where}  ${imageTag}`);
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
