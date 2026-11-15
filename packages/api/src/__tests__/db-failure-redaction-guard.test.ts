/**
 * Across packages/api/src, a caught failure reaches Sentry and the console as
 * facts, never as itself.
 *
 * A catch in this API almost always wraps a Prisma call over someone's words
 * (a mail, a Slack message, an imported KakaoTalk line, a title that quotes a
 * subject) or a provider call carrying them (Google, Graph, CalDAV, IMAP, web
 * push). A PrismaClientValidationError renders the rejected call's arguments
 * into its message in every errorFormat, a raw-query failure carries
 * Postgres's message (which quotes the value), and a provider error carries
 * the request it sent; Sentry sends the message and cause, and Node's console
 * prints every own property. So every catch, `.catch` handler, error-event
 * listener and Fastify error handler reports through report-db-failure.ts or
 * llm/report-llm-failure.ts (a fixed label plus facts) and never hands the
 * caught value, an alias of it, or its message to captureError / Sentry,
 * console.* or a pino logger. The global error handler (error-handler.ts),
 * which receives whatever a route rethrows, is held to the same rule.
 *
 * Every catch counts, not just those over a Prisma call: a catch over a call
 * that reaches the database a few frames down sees the same error. Scanning
 * rules are shared with the LLM guard (helpers/catch-sink-scan.ts), including
 * a reporter's `ids` / `extra`. Like it, this guard does not follow a caught
 * value into a function the handler calls, or through a value a function
 * returns; those sites have canary tests next to their features.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { scanCatches, scanFunctionSinks, type Violation, walk } from "./helpers/catch-sink-scan.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..");

/**
 * Directories whose sinks may print a failure whole, each with its reason. The
 * reason is checked below: nothing outside the directory imports it.
 */
const OPERATOR_ONLY_DIRS: ReadonlyArray<{ dir: string; reason: string }> = [
  {
    dir: "scripts/",
    reason:
      "Operator CLIs run by hand (`tsx src/scripts/<name>.ts`): no server module imports them, render.yaml starts only the web service, and nothing here imports Sentry, so their output is the operator's own terminal.",
  },
];

/** Single sinks that may print a failure's words, matched by file and a fragment of the call. */
const ALLOWED: ReadonlyArray<{ file: string; fragment: string; reason: string }> = [
  {
    file: "eval-v3/extract.ts",
    fragment: "[V3-FACTS] attempt",
    reason:
      "Offline bench (packages/api/scripts/v3-fact-eval.ts; no server importer, checked below): the operator owns the sample and the key, and needs the provider's words. The LLM guard allows it too.",
  },
  {
    file: "agentcore/tool-executor.ts",
    fragment: "[FLOOR] refused",
    reason:
      "Inside `instanceof` checks on the floor-refusal classes, whose messages are code-defined: a FLOOR_ACTIONS tool name, a receipt schema version, 12-character hash prefixes. The LLM guard allows it too.",
  },
  {
    file: "agentcore/tool-executor.ts",
    fragment: 'scope: "floor_refusal"',
    reason: "Same floor-refusal branch: a code-defined security event, kept whole for Sentry.",
  },
];

/** Places the scan must see catches in, so a moved directory cannot pass vacuously. */
const MUST_SEE = [
  "slack/",
  "kakao-import/",
  "pim/",
  "mail/",
  "judge/",
  "routes/",
  "agentcore/",
  "learning/",
  "notify/",
  "billing/",
  "drive/",
  "automation-scheduler.ts",
  "background.ts",
  "index.ts",
  "routes/calendar.ts",
  "routes/commitments.ts",
  "routes/kakao-import.ts",
  "routes/slack-events.ts",
] as const;

const everyCatch = () => true;

function sourceFiles(): Array<{ file: string; code: string }> {
  return walk(srcDir).map((full) => ({
    file: relative(srcDir, full).split("\\").join("/"),
    code: readFileSync(full, "utf8"),
  }));
}

function isAllowed(v: Violation): boolean {
  return (
    OPERATOR_ONLY_DIRS.some((d) => v.file.startsWith(d.dir)) ||
    ALLOWED.some((a) => a.file === v.file && v.text.includes(a.fragment))
  );
}

function scanTree(files: ReadonlyArray<{ file: string; code: string }>) {
  const violations: Violation[] = [];
  const catches = new Map<string, number>();
  for (const { file, code } of files) {
    const result = scanCatches(file, code, everyCatch);
    violations.push(...result.violations);
    catches.set(file, result.taintedCatches);
  }
  return { violations, catches };
}

/** Module specifiers a file imports or re-exports, static or dynamic. */
function importedSpecifiers(file: string, code: string): string[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** src-relative paths of the files outside `dir` that import a module inside it. */
function importersOf(dir: string, files: ReadonlyArray<{ file: string; code: string }>): string[] {
  return files
    .filter(({ file }) => !file.startsWith(dir))
    .filter(({ file, code }) =>
      importedSpecifiers(file, code).some((spec) => {
        if (!spec.startsWith(".")) return false;
        const target = relative(srcDir, join(srcDir, dirname(file), spec))
          .split("\\")
          .join("/");
        return target.startsWith(dir);
      }),
    )
    .map(({ file }) => file);
}

describe("database failure redaction guard (all of packages/api/src)", () => {
  const files = sourceFiles();
  const scan = scanTree(files);

  it("finds no catch that hands a caught failure to Sentry, the console or the log", () => {
    const offenders = scan.violations
      .filter((v) => !isAllowed(v))
      .map((v) => `${v.file}:${v.line}  ${v.text.slice(0, 160)}`);
    expect(offenders).toEqual([]);
  });

  it("holds the global error handler to the same rule", () => {
    const file = "error-handler.ts";
    const violations = scanFunctionSinks(
      file,
      readFileSync(join(srcDir, file), "utf8"),
      "handleError",
    );
    expect(violations.map((v) => `${v.file}:${v.line}  ${v.text}`)).toEqual([]);
  });

  it("cannot pass vacuously: it sees catches everywhere that writes content", () => {
    const total = [...scan.catches.values()].reduce((sum, n) => sum + n, 0);
    expect(total).toBeGreaterThan(700);
    for (const place of MUST_SEE) {
      const seen = [...scan.catches.entries()]
        .filter(([file]) => file === place || (place.endsWith("/") && file.startsWith(place)))
        .reduce((sum, [, n]) => sum + n, 0);
      expect(seen, place).toBeGreaterThan(0);
    }
  });

  it("keeps every allowlist entry live, and each allowed directory unimported by the server", () => {
    for (const entry of ALLOWED) {
      const live = scan.violations.some(
        (v) => v.file === entry.file && v.text.includes(entry.fragment),
      );
      expect(live, `${entry.file}: ${entry.fragment}`).toBe(true);
    }
    for (const { dir } of OPERATOR_ONLY_DIRS) {
      expect(importersOf(dir, files), dir).toEqual([]);
    }
    expect(importersOf("eval-v3/", files), "eval-v3/").toEqual([]);
  });
});

describe("the database guard itself", () => {
  const scanned = (body: string) =>
    scanCatches(
      "bad.ts",
      `async function f() { try { await prisma.slackMessage.create({ data }); } catch (err) { ${body} } }`,
      everyCatch,
    ).violations;

  it.each([
    ["captureError(err)", "captureError(err, { tags: { scope: 'x' } });"],
    ["console.error with the error", "console.error('[X] failed:', err);"],
    ["the message in a template", "console.warn(`[X] failed: ${(err as Error).message}`);"],
    ["a pino logger", "request.log.error(err, 'x');"],
  ])("flags %s", (_label, body) => {
    expect(scanned(body)).toHaveLength(1);
  });

  it("flags a .catch handler that logs the error", () => {
    const result = scanCatches(
      "bad.ts",
      "function f() { void prisma.reminder.updateMany({}).catch((e) => console.warn('x', e)); }",
      everyCatch,
    );
    expect(result.violations).toHaveLength(1);
  });

  it.each([
    ["an emitter's error listener", "client.on('error', (err) => console.error('[X]', err));"],
    [
      "a process-level listener",
      "process.on('unhandledRejection', (reason) => captureError(reason));",
    ],
    [
      "a Fastify error handler",
      "app.setErrorHandler((error, request, reply) => { request.log.error(error); reply.send(); });",
    ],
  ])("flags %s", (_label, code) => {
    const result = scanCatches("bad.ts", `function f() { ${code} }`, everyCatch);
    expect(result.violations).toHaveLength(1);
  });

  it("flags a named handler that logs its failure parameter, and passes one that reports facts", () => {
    const bad = scanFunctionSinks(
      "bad.ts",
      "export function handleError(error, request, reply) { request.log.error(error); }",
      "handleError",
    );
    expect(bad).toHaveLength(1);
    const good = scanFunctionSinks(
      "good.ts",
      "export function handleError(error, request, reply) { request.log.error({ failure: dbFailureFacts(error) }, 'x'); captureDbFailure('x', error, { tags: {} }); }",
      "handleError",
    );
    expect(good).toEqual([]);
    expect(() => scanFunctionSinks("gone.ts", "export const x = 1;", "handleError")).toThrow();
  });

  it.each([
    [
      "the helpers",
      "logDbFailure('[X] failed', err); captureDbFailure('[X] failed', err, { tags: { scope: 'x' } });",
    ],
    [
      "the facts",
      "const facts = dbFailureFacts(err); console.warn(`[X] ${formatDbFailureFacts(facts)}`);",
    ],
    ["the facts in pino", "request.log.error({ failure: dbFailureFacts(err) }, 'x');"],
    ["the class name", "console.warn(`[X] ${err instanceof Error ? err.name : 'unknown'}`);"],
  ])("accepts %s", (_label, body) => {
    expect(scanned(body)).toEqual([]);
  });

  it.each([
    [
      "the message in ids",
      "logDbFailure('[X] failed', err, { ids: { m: (err as Error).message } });",
    ],
    [
      "the error in Sentry extra",
      "captureDbFailure('[X] failed', err, { tags: { scope: 'x' }, extra: { detail: String(err) } });",
    ],
    [
      "an alias in the LLM reporter's extra",
      "const msg = (err as Error).message; captureLlmFailure('[X] failed', err, { tags: {}, extra: { msg } });",
    ],
  ])("flags %s", (_label, body) => {
    expect(scanned(body)).toHaveLength(1);
  });

  it("flags an interpolated label", () => {
    const result = scanCatches(
      "bad.ts",
      "function f(s: string, e: unknown) { logDbFailure(`[X] ${s}`, e); }",
      everyCatch,
    );
    expect(result.violations).toHaveLength(1);
  });

  it("knows an importer of an allowed directory when it sees one", () => {
    const files = [
      { file: "scripts/tool.ts", code: "export const x = 1;" },
      { file: "routes/a.ts", code: 'import { x } from "../scripts/tool.js";' },
      { file: "routes/b.ts", code: 'const m = await import("../scripts/tool.js");' },
      { file: "routes/c.ts", code: '// see scripts/tool.ts\nimport { y } from "./y.js";' },
    ];
    expect(importersOf("scripts/", files)).toEqual(["routes/a.ts", "routes/b.ts"]);
  });
});
