#!/usr/bin/env node
// A release tag must be "v" + the API's package version before images are
// published under it (publish-image.yml).
//
// `klorn upgrade 0.4.1` (packages/cli) pulls the images tagged 0.4.1 and waits
// for /api/health to report 0.4.1, and the API reports the version field of
// packages/api/package.json. An image whose tag differs from that version can
// never finish an upgrade: the health wait times out every time.
//
// Usage: node .github/scripts/check-release-version.mjs [tag] [--package <path>]
//   tag        defaults to $GITHUB_REF_NAME (the pushed tag in Actions)
//   --package  defaults to packages/api/package.json (tests point it elsewhere)
// Exits 0 when they match, 1 (with a GitHub error annotation) otherwise.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_PACKAGE = join(repoRoot, "packages", "api", "package.json");

function parseArgs(argv) {
  const packageAt = argv.indexOf("--package");
  const packagePath = packageAt === -1 ? DEFAULT_PACKAGE : argv[packageAt + 1];
  const positional =
    packageAt === -1 ? argv : argv.filter((_, i) => i !== packageAt && i !== packageAt + 1);
  const tag = positional.length > 0 ? positional[0] : process.env.GITHUB_REF_NAME;
  return { tag: tag ?? "", packagePath };
}

function fail(message) {
  console.error(`::error title=Release version::${message}`);
  process.exit(1);
}

const { tag, packagePath } = parseArgs(process.argv.slice(2));
if (!packagePath) fail("--package needs a path");

let version;
try {
  version = JSON.parse(readFileSync(packagePath, "utf8")).version;
} catch (err) {
  fail(`could not read the version from ${packagePath}: ${err.message}`);
}
if (typeof version !== "string" || version.length === 0) {
  fail(`${packagePath} has no version`);
}

if (tag !== `v${version}`) {
  fail(
    `tag "${tag}" does not match ${packagePath} version ${version}: ` +
      `tag the release v${version}, or bump the package version to ${tag.replace(/^v/, "")} first.`,
  );
}

console.log(`release tag ${tag} matches ${packagePath} version ${version}`);
