/**
 * An LLM failure reaches Sentry and the console as facts, never as itself.
 *
 * A provider error can quote the request, which on a production call is
 * someone's mail or chat; Gemini's error message is the raw response body; an
 * exhausted chain carries the provider error as `cause` (Sentry, pino and
 * Node's console all print it); JSON.parse's SyntaxError quotes the start of
 * the model's reply. #1774 and the sweep after it moved every such catch onto
 * llm/report-llm-failure.ts (a fixed label plus llmFailureFacts).
 *
 * This guard parses the API source and fails when a catch whose try block
 * calls something that throws LLM failures (LLM_THROWERS) hands the caught
 * value to a sink: captureError / Sentry, console.*, or a pino logger. Handing
 * it to a sanitizer (llmFailureFacts and friends) or reading `.name` /
 * `.status` is fine. It also holds every logLlmFailure / captureLlmFailure
 * label to a string literal, so content cannot be interpolated into it.
 *
 * It sees direct catches and `.catch(handler)` on a call chain, plus aliases
 * made in the handler (declared, destructured or assigned). It does not follow
 * a thrown value through Promise.allSettled, a callback or a function the
 * handler calls, and it does not police `ids` / `extra` values; those sites
 * have canary tests next to their features (sender-trait-extractor,
 * proactive-drafts, routes-reply-draft, auto-mode-sweep, error-handler, …).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..");

/**
 * Functions that let an LLM failure out to their caller. A function that
 * catches its own model failures (judgeEmail, generateBriefing, runChatTurn,
 * summariseDriveText) is not listed; its own catch is checked where the model
 * call sits.
 */
const LLM_THROWERS = new Set([
  "createCompletion",
  "createVisionCompletion",
  "parseLlmJson",
  "summarizeEmail",
  "summarizeEmailOnDemand",
  "generateReplyDraft",
  "draftReplyForEmailId",
  "getSenderDossier",
  "compileRuleText",
  "parseEventText",
  "generateSmartReply",
  "generateGuidelineReply",
  "buildPath",
  "getOrBuildPath",
  "summarizeMeeting",
]);

/** Direct SDK calls outside the provider layer. */
const LLM_SDK_CALLS = [".chat.completions.create", ".embeddings.create"];

/** Calls that may take the caught value: they read only its class, status and codes. */
const SANITIZERS = new Set([
  "llmFailureFacts",
  "formatLlmFailureFacts",
  "describeLlmFailure",
  "llmFailureName",
  "llmFailureStatus",
  "isLlmFailure",
  "isDataWipeFenceError",
  "costCapRefusal",
]);

/** Properties of the caught value that are safe to read into a sink. */
const SAFE_PROPERTIES = new Set(["name", "status"]);

const CONSOLE_METHODS = new Set(["log", "warn", "error", "info", "debug", "trace"]);
const PINO_METHODS = new Set(["info", "warn", "error", "debug", "fatal", "trace"]);
const SENTRY_FUNCTIONS = new Set([
  "captureError",
  "captureException",
  "captureMessage",
  "addBreadcrumb",
]);
const LABELLED_REPORTERS = new Set(["logLlmFailure", "captureLlmFailure"]);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

interface ScanResult {
  readonly violations: Violation[];
  /** Catches (and .catch handlers) the guard treated as receiving LLM failures. */
  readonly taintedCatches: number;
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function callsLlmThrower(node: ts.Node, source: ts.SourceFile): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    // A nested try with its own catch handles what its block throws; that
    // catch is checked on its own. Its catch and finally still throw outward.
    if (ts.isTryStatement(child) && child.catchClause) {
      visit(child.catchClause.block);
      if (child.finallyBlock) visit(child.finallyBlock);
      return;
    }
    if (ts.isCallExpression(child)) {
      const name = calleeName(child);
      const text = child.expression.getText(source);
      if (
        (name !== null && LLM_THROWERS.has(name)) ||
        LLM_SDK_CALLS.some((suffix) => text.endsWith(suffix))
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function isSink(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return SENTRY_FUNCTIONS.has(callee.text);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const method = callee.name.text;
  const target = callee.expression;
  if (ts.isIdentifier(target) && target.text === "console") return CONSOLE_METHODS.has(method);
  if (ts.isIdentifier(target) && target.text === "Sentry") return SENTRY_FUNCTIONS.has(method);
  // request.log.error(...), app.log.warn(...), fastify.log.info(...)
  return (
    ts.isPropertyAccessExpression(target) && target.name.text === "log" && PINO_METHODS.has(method)
  );
}

/** Whether `expr` carries a tainted value's text (not just its class or status). */
function exposes(expr: ts.Node, tainted: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(expr)) return tainted.has(expr.text);
  if (ts.isPropertyAccessExpression(expr)) {
    if (
      ts.isIdentifier(expr.expression) &&
      tainted.has(expr.expression.text) &&
      SAFE_PROPERTIES.has(expr.name.text)
    ) {
      return false;
    }
    return exposes(expr.expression, tainted);
  }
  if (ts.isCallExpression(expr)) {
    const name = calleeName(expr);
    if (name !== null && SANITIZERS.has(name)) return false;
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
    return false;
  }
  if (ts.isTypeOfExpression(expr)) return false;
  let found = false;
  ts.forEachChild(expr, (child) => {
    if (!found && exposes(child, tainted)) found = true;
  });
  return found;
}

/** The caught name plus any local declared in the handler from an exposing initializer. */
/** Identifiers a declaration binds: `x`, or every name in `{ a, b: c }` / `[d, e]`. */
function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? boundNames(element.name) : [],
  );
}

/** The caught name plus any local the handler derives from it (declared, destructured, assigned). */
function taintedNames(caught: string, body: ts.Node): Set<string> {
  const tainted = new Set([caught]);
  for (let grew = true; grew; ) {
    grew = false;
    const taint = (names: string[]): void => {
      for (const name of names) {
        if (!tainted.has(name)) {
          tainted.add(name);
          grew = true;
        }
      }
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer !== undefined &&
        exposes(node.initializer, tainted)
      ) {
        taint(boundNames(node.name));
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        exposes(node.right, tainted)
      ) {
        taint([node.left.text]);
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
  }
  return tainted;
}

function sinkViolations(
  body: ts.Node,
  caught: string,
  source: ts.SourceFile,
  file: string,
): Violation[] {
  const tainted = taintedNames(caught, body);
  const out: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      isSink(node) &&
      node.arguments.some((a) => exposes(a, tainted))
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      out.push({ file, line: line + 1, text: node.getText(source).replace(/\s+/g, " ") });
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return out;
}

function handlerOf(arg: ts.Expression | undefined): { caught: string; body: ts.Node } | null {
  if (arg === undefined || !(ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) return null;
  const param = arg.parameters[0];
  if (param === undefined || !ts.isIdentifier(param.name)) return null;
  return { caught: param.name.text, body: arg.body };
}

function isStringLiteralLike(node: ts.Node | undefined): boolean {
  return (
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
  );
}

/**
 * Names that are only ever bound by `const name = "literal"` in the file. A
 * name also declared any other way (a `let`, a template, a parameter) anywhere
 * in the file does not count, so another function's interpolated `label`
 * cannot pass for this one's literal.
 */
function constStringNames(source: ts.SourceFile): Set<string> {
  const literal = new Set<string>();
  const other = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclarationList(node)) {
      const isConst = (node.flags & ts.NodeFlags.Const) !== 0;
      for (const decl of node.declarations) {
        const literalConst =
          isConst && ts.isIdentifier(decl.name) && isStringLiteralLike(decl.initializer);
        for (const name of boundNames(decl.name)) (literalConst ? literal : other).add(name);
      }
    }
    if (ts.isParameter(node)) for (const name of boundNames(node.name)) other.add(name);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return new Set([...literal].filter((name) => !other.has(name)));
}

function labelViolation(
  call: ts.CallExpression,
  source: ts.SourceFile,
  file: string,
  constStrings: ReadonlySet<string>,
): Violation | null {
  const name = calleeName(call);
  if (name === null || !LABELLED_REPORTERS.has(name)) return null;
  const label = call.arguments[0];
  if (isStringLiteralLike(label)) return null;
  if (label !== undefined && ts.isIdentifier(label) && constStrings.has(label.text)) return null;
  const { line } = source.getLineAndCharacterOfPosition(call.getStart(source));
  return { file, line: line + 1, text: `label must be a string literal: ${call.getText(source)}` };
}

function scanSource(file: string, code: string): ScanResult {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: Violation[] = [];
  const constStrings = constStringNames(source);
  let taintedCatches = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isTryStatement(node) && node.catchClause?.variableDeclaration) {
      const declared = node.catchClause.variableDeclaration.name;
      if (ts.isIdentifier(declared) && callsLlmThrower(node.tryBlock, source)) {
        taintedCatches++;
        violations.push(...sinkViolations(node.catchClause.block, declared.text, source, file));
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "catch" &&
        callsLlmThrower(callee.expression, source)
      ) {
        const handler = handlerOf(node.arguments[0]);
        if (handler !== null) {
          taintedCatches++;
          violations.push(...sinkViolations(handler.body, handler.caught, source, file));
        }
      }
      const label = labelViolation(node, source, file, constStrings);
      if (label !== null) violations.push(label);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { violations, taintedCatches };
}

/**
 * Sinks that may carry an LLM failure's own words, each with its reason.
 * Matched by file and a fragment of the call's text.
 */
const ALLOWED: ReadonlyArray<{ file: string; fragment: string; reason: string }> = [
  {
    file: "eval-v3/extract.ts",
    fragment: "[V3-FACTS] attempt",
    reason:
      "Offline bench CLI (no src importer): the operator owns the sample and the key, and needs the provider's words.",
  },
  {
    file: "agentcore/tool-executor.ts",
    fragment: "[FLOOR] refused",
    reason:
      "Inside `instanceof` floor-refusal checks: those errors' messages are code-defined (tool name, receipt schema, hash prefixes).",
  },
  {
    file: "agentcore/tool-executor.ts",
    fragment: 'scope: "floor_refusal"',
    reason: "Same floor-refusal branch: a code-defined security event, kept whole for Sentry.",
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__" || entry === "__fixtures__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function scanTree(): ScanResult & { perFile: Map<string, number> } {
  const violations: Violation[] = [];
  const perFile = new Map<string, number>();
  let taintedCatches = 0;
  for (const full of walk(srcDir)) {
    const file = relative(srcDir, full).split("\\").join("/");
    const result = scanSource(file, readFileSync(full, "utf8"));
    violations.push(...result.violations);
    taintedCatches += result.taintedCatches;
    if (result.taintedCatches > 0) perFile.set(file, result.taintedCatches);
  }
  return { violations, taintedCatches, perFile };
}

function isAllowed(v: Violation): boolean {
  return ALLOWED.some((a) => a.file === v.file && v.text.includes(a.fragment));
}

describe("LLM failure redaction guard", () => {
  const tree = scanTree();

  it("finds no catch that hands an LLM failure to Sentry, the console or the log", () => {
    const offenders = tree.violations
      .filter((v) => !isAllowed(v))
      .map((v) => `${v.file}:${v.line}  ${v.text.slice(0, 160)}`);
    expect(offenders).toEqual([]);
  });

  it("has no stale allowlist entry", () => {
    const stale = ALLOWED.filter(
      (a) => !tree.violations.some((v) => v.file === a.file && v.text.includes(a.fragment)),
    );
    expect(stale).toEqual([]);
  });

  it("cannot pass vacuously: it sees the LLM catches it was written for", () => {
    for (const file of [
      "judge/email-classifier.ts",
      "event-parse.ts",
      "mail/rule-compile.ts",
      "mail/email-summarize.ts",
      "mail/thread-brief.ts",
      "routes/email-replies.ts",
      "routes/email.ts",
      "routes/calendar.ts",
      "agentcore/chat-engine.ts",
      "agentcore/autonomous-agent.ts",
      "automation-scheduler.ts",
      "embedding.ts",
    ]) {
      expect(tree.perFile.get(file) ?? 0, file).toBeGreaterThan(0);
    }
    expect(tree.taintedCatches).toBeGreaterThanOrEqual(25);
  });

  it("names only throwers that still exist", () => {
    const sources = walk(srcDir).map((f) => readFileSync(f, "utf8"));
    const missing = [...LLM_THROWERS].filter(
      (name) => !sources.some((code) => new RegExp(`function ${name}\\b`).test(code)),
    );
    expect(missing).toEqual([]);
  });
});

describe("the guard itself", () => {
  const bad = (body: string) =>
    scanSource(
      "bad.ts",
      `async function f() { try { await createCompletion({}); } catch (err) { ${body} } }`,
    );

  it.each([
    ["captureError(err)", "captureError(err, { tags: { scope: 'x' } });"],
    ["Sentry.captureException(err)", "Sentry.captureException(err);"],
    ["console.warn with the error", "console.warn('[X] failed', err);"],
    ["console.error of the message", "console.error(`[X] failed: ${err.message}`);"],
    [
      "String(err) in Sentry extra",
      "captureError(new Error('x'), { extra: { reason: String(err) } });",
    ],
    [
      "an alias of the message",
      "const msg = err instanceof Error ? err.message : String(err); console.warn(msg);",
    ],
    ["a pino logger", "request.log.error(err);"],
  ])("flags %s", (_label, body) => {
    expect(bad(body).violations).toHaveLength(1);
  });

  it.each([
    ["a destructured message", "const { message } = err as Error; console.warn(message);"],
    ["an assigned message", "let m = ''; m = (err as Error).message; captureError(new Error(m));"],
    ["a breadcrumb", "addBreadcrumb('llm', String(err));"],
  ])("flags %s", (_label, body) => {
    expect(bad(body).violations).toHaveLength(1);
  });

  it("does not let one function's literal label vouch for another's interpolated one", () => {
    const result = scanSource(
      "bad.ts",
      [
        "function a(e: unknown) { const label = '[A] failed'; logLlmFailure(label, e); }",
        "function b(s: string, e: unknown) { const label = `[B] ${s}`; logLlmFailure(label, e); }",
      ].join("\n"),
    );
    expect(result.violations).toHaveLength(2);
  });

  it("flags a .catch handler on an LLM call", () => {
    const result = scanSource(
      "bad.ts",
      "function f() { void parseEventText('u', 't').catch((e) => console.warn('x', e)); }",
    );
    expect(result.violations).toHaveLength(1);
  });

  it("flags a catch whose model reply parse failed", () => {
    const result = scanSource(
      "bad.ts",
      "function f(c: string) { try { return parseLlmJson(c); } catch (e) { captureError(e); } }",
    );
    expect(result.violations).toHaveLength(1);
  });

  it("flags an interpolated label, directly or through a variable", () => {
    const direct = scanSource(
      "bad.ts",
      "function f(s: string, e: unknown) { logLlmFailure(`[X] ${s}`, e); }",
    );
    const viaLet = scanSource(
      "bad.ts",
      "function f(s: string, e: unknown) { let label = `[X] ${s}`; captureLlmFailure(label, e, { tags: {} }); }",
    );
    expect(direct.violations).toHaveLength(1);
    expect(viaLet.violations).toHaveLength(1);
  });

  it("accepts a label held in a const string literal", () => {
    const result = scanSource(
      "ok.ts",
      "function f(e: unknown) { const label = '[X] failed'; logLlmFailure(label, e); }",
    );
    expect(result.violations).toEqual([]);
  });

  it.each([
    [
      "the helpers",
      "logLlmFailure('[X] failed', err); captureLlmFailure('[X] failed', err, { tags: { scope: 'x' } });",
    ],
    [
      "the facts",
      "const facts = llmFailureFacts(err); captureError(new Error('x'), { extra: { ...facts } }); console.warn(`x ${formatLlmFailureFacts(facts)}`);",
    ],
    [
      "the class name and status",
      "console.warn(`[X] ${err instanceof Error ? err.name : 'unknown'} ${err.status}`);",
    ],
    ["a fixed error", "captureError(new Error('[X] failed'), { tags: { scope: 'x' } });"],
  ])("accepts %s", (_label, body) => {
    expect(bad(body).violations).toEqual([]);
  });

  it("ignores catches whose try block calls no LLM", () => {
    const result = scanSource(
      "ok.ts",
      "async function f() { try { await prisma.user.findMany(); } catch (err) { captureError(err); } }",
    );
    expect(result).toEqual({ violations: [], taintedCatches: 0 });
  });
});
