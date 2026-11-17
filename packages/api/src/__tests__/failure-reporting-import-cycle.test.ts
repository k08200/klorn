/**
 * The failure-reporting modules sit under every catch in the API, so none of
 * them may sit on an import cycle.
 *
 * In ESM a cycle hands one module the other's bindings before they are
 * initialised; it works only while every use waits for a call. One top-level
 * use (a constant built from an imported helper, a class that extends one)
 * turns it into a TDZ crash at boot, in the module every catch reports
 * through. The fence error predicate used to close the loop
 * data-wipe-fence -> report-db-failure -> report-failure -> data-wipe-fence
 * (and sentry -> data-wipe-fence -> ... -> sentry); it now lives in a leaf.
 * The facts and frames the process-fault integrations need (sentry.ts builds
 * them in) are leaves for the same reason.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { walk } from "./helpers/catch-sink-scan.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..");

/** The modules a catch reports through, and the leaves they depend on. */
const REPORTING_MODULES = [
  "sentry.ts",
  "sentry-process-faults.ts",
  "report-failure.ts",
  "report-db-failure.ts",
  "llm/report-llm-failure.ts",
  "privacy/data-wipe-fence.ts",
  "privacy/data-wipe-fence-error.ts",
  "db-failure-facts.ts",
  "error-frames.ts",
  // The address tag the log lines use (mail/email.ts and the routes import it).
  // Its key is built at module top from auth.ts, which a cycle would hand it
  // uninitialised (a TDZ crash at boot).
  "security/address-log-tag.ts",
] as const;

/** Modules that must import nothing at runtime, so no cycle can ever pass through them. */
const LEAVES = [
  "privacy/data-wipe-fence-error.ts",
  "db-failure-facts.ts",
  "error-frames.ts",
] as const;

/** Whether a declaration loads its module at runtime (`import type` and all-type specifiers do not). */
function loadsAtRuntime(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return false;
    const clause = node.exportClause;
    return !(
      clause !== undefined &&
      ts.isNamedExports(clause) &&
      clause.elements.length > 0 &&
      clause.elements.every((e) => e.isTypeOnly)
    );
  }
  const clause = node.importClause;
  if (clause === undefined) return true; // side-effect import
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  const bindings = clause.namedBindings;
  if (bindings === undefined || ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.length === 0 || bindings.elements.some((e) => !e.isTypeOnly);
}

/** src-relative files a module loads at runtime: static imports, re-exports and dynamic import(). */
function runtimeImports(file: string, code: string, known: ReadonlySet<string>): string[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      loadsAtRuntime(node)
    ) {
      specs.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specs
    .filter((spec) => spec.startsWith("."))
    .map((spec) => {
      const base = relative(srcDir, join(srcDir, dirname(file), spec))
        .split("\\")
        .join("/")
        .replace(/\.js$/, "");
      return [`${base}.ts`, `${base}/index.ts`].find((candidate) => known.has(candidate));
    })
    .filter((target): target is string => target !== undefined);
}

/** The shortest import path from `start` back to itself, or null. */
function cycleThrough(start: string, graph: ReadonlyMap<string, string[]>): string[] | null {
  const previous = new Map<string, string>();
  const queue = [...(graph.get(start) ?? [])];
  for (const next of queue) previous.set(next, start);
  while (queue.length > 0) {
    const node = queue.shift() as string;
    if (node === start) {
      const path = [start];
      let at = previous.get(start) as string;
      while (at !== start) {
        path.unshift(at);
        at = previous.get(at) as string;
      }
      return [start, ...path];
    }
    for (const next of graph.get(node) ?? []) {
      if (!previous.has(next)) {
        previous.set(next, node);
        queue.push(next);
      }
    }
  }
  return null;
}

function importGraph(): Map<string, string[]> {
  const files = walk(srcDir).map((full) => ({
    file: relative(srcDir, full).split("\\").join("/"),
    code: readFileSync(full, "utf8"),
  }));
  const known = new Set(files.map(({ file }) => file));
  return new Map(files.map(({ file, code }) => [file, runtimeImports(file, code, known)]));
}

describe("failure-reporting modules import no cycle", () => {
  const graph = importGraph();

  it.each(REPORTING_MODULES)("%s is on no import cycle", (file) => {
    expect(graph.has(file), `${file} exists`).toBe(true);
    expect(cycleThrough(file, graph)).toBeNull();
  });

  it.each(LEAVES)("%s imports nothing at runtime", (file) => {
    expect(graph.get(file)).toEqual([]);
  });
});

describe("the cycle check itself", () => {
  const known = new Set(["a.ts", "b.ts", "c.ts", "d/index.ts"]);

  it("follows static, re-exported and dynamic imports, and skips type-only ones", () => {
    const code = [
      'import { x } from "./b.js";',
      'export { y } from "./c.js";',
      'import type { T } from "./c.js";',
      'import { type U } from "./c.js";',
      'const m = await import("./d/index.js");',
      'import { z } from "node:fs";',
    ].join("\n");
    expect(runtimeImports("a.ts", code, known)).toEqual(["b.ts", "c.ts", "d/index.ts"]);
    expect(runtimeImports("a.ts", 'import type { T } from "./b.js";', known)).toEqual([]);
  });

  it("finds a cycle and names its path, and passes a chain", () => {
    const loop = new Map([
      ["a.ts", ["b.ts"]],
      ["b.ts", ["c.ts"]],
      ["c.ts", ["a.ts"]],
    ]);
    expect(cycleThrough("a.ts", loop)).toEqual(["a.ts", "b.ts", "c.ts", "a.ts"]);
    const chain = new Map([
      ["a.ts", ["b.ts"]],
      ["b.ts", ["c.ts"]],
      ["c.ts", []],
    ]);
    expect(cycleThrough("a.ts", chain)).toBeNull();
  });
});
