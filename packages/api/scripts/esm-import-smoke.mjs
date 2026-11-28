/**
 * ESM import smoke: loads every module the API entry point imports (static
 * and dynamic), under Node's real ESM loader, without running the entry
 * point itself (index listens on a port and connects to the database).
 *
 * Why: a dependency that drops an export the code imports — web-push 4 is
 * ESM-only with no default export — makes `node dist/index.js` die at boot
 * with "does not provide an export named 'default'", while tsc stays green
 * (the CJS-shaped @types synthesize a default) and so does vitest (its
 * module interop hands back the namespace when a default is missing). Only
 * Node's own linker catches it, so this runs under Node's own linker.
 *
 * Modules are evaluated, not just linked, so run it with NODE_ENV=test: some
 * refuse to load keyless outside dev/test (TOKEN_ENCRYPTION_KEY). Nothing
 * here needs DATABASE_URL; Prisma connects on first query, and none runs.
 *
 * Usage (from packages/api):
 *   NODE_ENV=test node scripts/esm-import-smoke.mjs dist               built output (CI Build job)
 *   NODE_ENV=test node --import tsx scripts/esm-import-smoke.mjs src   sources (esm-import-smoke.test.ts)
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// index imports ~49 modules; far fewer means the parse below stopped matching.
const MIN_EXPECTED_MODULES = 30;
const RELATIVE_IMPORT = /(?:\bfrom\s+|\bimport\(\s*)"(\.{1,2}\/[^"]+\.js)"/g;
// index's own package imports (`import Fastify from "fastify"`). Its modules
// are linked by importing them; index itself is never imported, so the exports
// it takes from packages are checked by name below.
const PACKAGE_IMPORT = /^import\s+(?!type\s)([^;"]+?)\s+from\s+"([^./][^"]*)"/gm;

function fail(message) {
  console.error(`esm-import-smoke: ${message}`);
  process.exit(1);
}

const describe = (err) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

/** The export names `import <clause> from "pkg"` needs the package to have. */
function requiredExports(clause) {
  const names = /^[A-Za-z_$][\w$]*\s*(?:,|$)/.test(clause.trim()) ? ["default"] : [];
  const named = /\{([^}]*)\}/.exec(clause);
  for (const part of named ? named[1].split(",") : []) {
    const name = part.trim();
    if (name && !name.startsWith("type ")) names.push(name.split(/\s+as\s+/)[0]);
  }
  return names;
}

const dir = resolve(process.argv[2] ?? "dist");
const isSource = existsSync(join(dir, "index.ts"));
const entry = join(dir, isSource ? "index.ts" : "index.js");
if (!existsSync(entry)) fail(`no index.ts or index.js in ${dir}`);

const source = readFileSync(entry, "utf8");
const specifiers = [...new Set([...source.matchAll(RELATIVE_IMPORT)].map((m) => m[1]))];
if (specifiers.length < MIN_EXPECTED_MODULES) {
  fail(`found ${specifiers.length} imports in ${entry}, expected at least ${MIN_EXPECTED_MODULES}`);
}

for (const specifier of specifiers) {
  const file = join(dir, isSource ? specifier.replace(/\.js$/, ".ts") : specifier);
  try {
    await import(pathToFileURL(file).href);
  } catch (err) {
    fail(`${specifier}: ${describe(err)}`);
  }
}

// What Node's linker would check for index itself: a default import needs a
// `default` export (always present on a CommonJS package, absent on an
// ESM-only one that has none), a named import needs that name.
const packageImports = [...source.matchAll(PACKAGE_IMPORT)];
for (const [, clause, pkg] of packageImports) {
  let namespace;
  try {
    namespace = await import(pkg);
  } catch (err) {
    fail(`"${pkg}": ${describe(err)}`);
  }
  const missing = requiredExports(clause).filter((name) => !(name in namespace));
  if (missing.length > 0) {
    fail(`"${pkg}" does not provide an export named ${missing.join(", ")} (imported by ${entry})`);
  }
}

console.log(
  `esm-import-smoke: loaded ${specifiers.length} modules and checked ${packageImports.length} package imports from ${entry}`,
);
// Imported modules may hold timers or pools open; the smoke is done.
process.exit(0);
