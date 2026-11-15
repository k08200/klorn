/**
 * The catch-to-sink scanner behind the redaction guards
 * (llm-failure-redaction-guard, db-failure-redaction-guard).
 *
 * scanCatches parses one source file and reports every catch (and
 * `.catch(handler)` on a call chain, an `.on("error", handler)` listener, a
 * `setErrorHandler(handler)`) that the caller's `taints` predicate selects and
 * that hands the caught value, an alias of it, or its message to a sink:
 * captureError / Sentry / addBreadcrumb, console.*, or a pino logger.
 * scanFunctionSinks does the same for a named function's first parameter (the
 * global error handler, which receives whatever a route throws).
 * Handing it to a sanitizer (the facts helpers) or reading `.name` /
 * `.status` is fine. It also holds every labelled reporter's label to a
 * string literal, so content cannot be interpolated into it.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

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
  "dbFailureFacts",
  "formatDbFailureFacts",
  // pim/caldav/caldav-errors.ts: a constant class per error kind, codes held to a token shape.
  "caldavErrorClass",
  // report-failure.ts: the stack's frame lines only, or null when the header cannot be matched.
  "originalFrames",
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
const LABELLED_REPORTERS = new Set([
  "logLlmFailure",
  "captureLlmFailure",
  "logDbFailure",
  "captureDbFailure",
]);

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface ScanResult {
  readonly violations: Violation[];
  /** Catches (and .catch handlers) the predicate selected. */
  readonly taintedCatches: number;
}

export function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
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

/**
 * The arguments of `call` that reach a log or Sentry: all of a sink's, and a
 * labelled reporter's options (its `ids` / `extra`), which it prints and sends
 * as given. A reporter's label is held to a literal separately, and the
 * failure itself (the second argument) is what it reduces to facts.
 */
function sinkArguments(call: ts.CallExpression): readonly ts.Expression[] {
  if (isSink(call)) return call.arguments;
  const name = calleeName(call);
  return name !== null && LABELLED_REPORTERS.has(name) ? call.arguments.slice(2) : [];
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
  followAliases = true,
): Violation[] {
  const tainted = followAliases ? taintedNames(caught, body) : new Set([caught]);
  const out: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && sinkArguments(node).some((a) => exposes(a, tainted))) {
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

/** Events whose listener receives a failure: an emitter's error, a process-level rejection. */
const ERROR_EVENTS = new Set(["error", "unhandledRejection", "uncaughtException"]);

/**
 * The failure handler a call registers, with the expression the guard's
 * predicate judges: `.catch(h)` on a chain, `.on("error", h)` / `.once(...)` on
 * an emitter (the predicate sees the emitter), `setErrorHandler(h)`.
 */
function registeredHandler(
  call: ts.CallExpression,
): { handler: ts.Expression | undefined; subject: ts.Expression } | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee) && callee.text === "setErrorHandler") {
    return { handler: call.arguments[0], subject: callee };
  }
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const method = callee.name.text;
  if (method === "catch") return { handler: call.arguments[0], subject: callee.expression };
  if (method === "setErrorHandler") {
    return { handler: call.arguments[0], subject: callee.expression };
  }
  const event = call.arguments[0];
  if (
    (method === "on" || method === "once") &&
    event !== undefined &&
    ts.isStringLiteralLike(event) &&
    ERROR_EVENTS.has(event.text)
  ) {
    return { handler: call.arguments[1], subject: callee.expression };
  }
  return null;
}

/** Parameter names that hold a failure handed on by a catch: `err`, `error`, `reason`, `lastErr`, … */
const FAILURE_PARAM = /^(e|ex|err|error|reason|cause|failure|exception)$|Err$|Error$/;
/** A parameter typed as one of these can hold a caught failure; `string`, an indexed enum, … cannot. */
const FAILURE_TYPE = /^(unknown|any|[\w.]*(Error|Exception))(\s*\|\s*[\w.]+)*$/;

/** The failure-holding parameters of a function: a helper a catch hands its error to. */
function failureParameters(fn: ts.SignatureDeclaration): string[] {
  return fn.parameters.flatMap((param) =>
    ts.isIdentifier(param.name) &&
    FAILURE_PARAM.test(param.name.text) &&
    (param.type === undefined || FAILURE_TYPE.test(param.type.getText()))
      ? [param.name.text]
      : [],
  );
}

function isFunctionWithBody(
  node: ts.Node,
): node is
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)) &&
    node.body !== undefined
  );
}

export interface ScanOptions {
  /**
   * Also hold every function whose failure-named parameter (`err: unknown`,
   * `error`, `reason`, …) reaches a sink: the helper a catch hands its error
   * to (`report(what, err)`), a listener registered by reference.
   */
  readonly failureParameters?: boolean;
}

/** Which catches receive the failures a guard is about: given the try block, or the chain a `.catch` hangs on. */
export type TaintPredicate = (node: ts.Node, source: ts.SourceFile) => boolean;

export function scanCatches(
  file: string,
  code: string,
  taints: TaintPredicate,
  options: ScanOptions = {},
): ScanResult {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: Violation[] = [];
  const constStrings = constStringNames(source);
  /** Handlers already scanned as a `.catch` / listener, so the parameter pass skips them. */
  const scannedHandlers = new Set<ts.Node>();
  let taintedCatches = 0;
  const visit = (node: ts.Node): void => {
    if (options.failureParameters && isFunctionWithBody(node) && !scannedHandlers.has(node)) {
      // The parameter itself, not locals derived from it: a helper often
      // derives a safe class or code first, which only a sanitizer call proves.
      for (const param of failureParameters(node)) {
        violations.push(...sinkViolations(node.body as ts.Node, param, source, file, false));
      }
    }
    if (ts.isTryStatement(node) && node.catchClause?.variableDeclaration) {
      const declared = node.catchClause.variableDeclaration.name;
      if (ts.isIdentifier(declared) && taints(node.tryBlock, source)) {
        taintedCatches++;
        violations.push(...sinkViolations(node.catchClause.block, declared.text, source, file));
      }
    }
    if (ts.isCallExpression(node)) {
      const registered = registeredHandler(node);
      if (registered !== null && taints(registered.subject, source)) {
        const handler = handlerOf(registered.handler);
        if (handler !== null && registered.handler !== undefined) {
          scannedHandlers.add(registered.handler);
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
 * Sinks in the named function declaration that expose its first parameter:
 * for a handler that receives a failure as an argument rather than in a catch
 * (error-handler.ts's handleError). Throws when the function is missing, so a
 * rename cannot pass the guard vacuously.
 */
export function scanFunctionSinks(file: string, code: string, functionName: string): Violation[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) found = node;
    if (found === undefined) ts.forEachChild(node, visit);
  };
  visit(source);
  const param = found?.parameters[0];
  if (found?.body === undefined || param === undefined || !ts.isIdentifier(param.name)) {
    throw new Error(`${file}: no function ${functionName}(failure, …) to scan`);
  }
  return sinkViolations(found.body, param.name.text, source, file);
}

/** The API's source files under `dir`: no tests, fixtures, declarations or node_modules. */
export function walk(dir: string): string[] {
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
