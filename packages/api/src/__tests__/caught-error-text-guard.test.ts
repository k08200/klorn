/**
 * Across packages/api/src, a caught failure's text never leaves the catch.
 *
 * The log and Sentry guards (db-/llm-failure-redaction-guard) hold the
 * console and Sentry sinks. This one holds everything else a catch can do
 * with an error's words: send them in a response, return them to a caller
 * that answers or logs them later, store them in a column, or hand them to
 * the model as a tool result. A Prisma error renders the call's arguments
 * (other people's mail, titles), a JSON.parse SyntaxError quotes the model's
 * answer, and a provider error can quote the request — so a catch reduces a
 * failure to a code and facts (public-failure.ts, agentcore/tool-failure.ts)
 * instead of reading its text.
 *
 * Rule: in every `catch` clause and `.catch(handler)`, the caught value's
 * `.message` / `.stack`, `String(err)` and `${err}` may be read only to
 * classify it (a comparison, `.test()`, `.includes()`, `.startsWith()`,
 * `.endsWith()`, `.length`). Any other read must be listed in ALLOWED with
 * the reason its text is Klorn-written or never leaves an operator surface.
 * Aliases (`const e = err as …`) count as the caught value.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { walk } from "./helpers/catch-sink-scan.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..");

/** Operator CLIs (`tsx src/scripts/<name>.ts`): their output is the operator's own terminal. */
const SKIPPED_DIRS = ["scripts/"];

/** Reads of a caught error's text that are allowed, matched by file and a fragment of the line. */
const ALLOWED: ReadonlyArray<{ file: string; fragment: string; reason: string }> = [
  {
    file: "agentcore/agent-eval.ts",
    fragment: "message: err instanceof Error ? err.message : String(err)",
    reason:
      "The agent eval's own scenarios (EVAL_SCENARIOS) throw code-written assertions; no provider or database call runs inside them.",
  },
  {
    file: "agentcore/tool-executor.ts",
    fragment: "[FLOOR] refused",
    reason:
      "Inside `instanceof` checks on the floor-refusal classes, whose messages are code-defined (a FLOOR_ACTIONS name, a schema version, hash prefixes). The log guards allow it too.",
  },
  {
    file: "auth/apple.ts",
    fragment: "detail: (err as Error).message",
    reason:
      "A jose verification error (signature/issuer/audience): its message is jose's own fixed text about the token's claims. `detail` stays inside auth/apple.ts's result; routes/social-auth.ts answers `reason` only.",
  },
  {
    file: "auth/google-grant-revoke.ts",
    fragment: "const message = err instanceof Error ? err.message : String(err)",
    reason:
      "Classification only: the local is read by two regex tests (invalid_rapt, invalid_grant) and never returned.",
  },
  {
    file: "billing/paddle-price-check.ts",
    fragment: "problems: [(err as Error).message]",
    reason:
      "parseAdvertisedAmount's own code-written parse errors over the operator's advertised-price constant; the report goes to the price-consistency check, not a user.",
  },
  {
    file: "eval-v3/extract.ts",
    fragment: "const why = err instanceof Error ? err.message : String(err)",
    reason:
      "Offline bench (no server importer): the operator owns the sample and the key and needs the provider's words. The log guards allow it too.",
  },
  {
    file: "mail/activity-sync.ts",
    fragment: "const msg = err instanceof Error ? err.message : String(err)",
    reason: "Classification only: `/not connected/i.test(msg)` decides whether to report.",
  },
  {
    file: "mail/email-sync.ts",
    fragment: "const msg = err instanceof Error ? err.message : String(err)",
    reason: "Classification only: `/not connected/i.test(msg)` decides whether to report.",
  },
  {
    file: "mail/file-conversions.ts",
    fragment: 'detail: err instanceof Error ? err.message : "Quality test failed."',
    reason:
      "The conversion quality suite converts built-in sample fixtures, never a user's attachment; its failures are FileConversionError's fixed sentences or the suite's own assertions.",
  },
  {
    file: "pim/team-availability-members.ts",
    fragment: "error: err.message, code: err.code",
    reason: "Inside `isOrgError(err)`: an OrgError's message is code-written (org/errors.ts).",
  },
  {
    file: "routes/admin.ts",
    fragment: "detail: (err as Error).message",
    reason:
      "Admin-only diagnostic (requireAdmin): jose's parse error for the operator's own APPLE_PRIVATE_KEY, which it never quotes.",
  },
  {
    file: "routes/admin.ts",
    fragment: "const msg = err instanceof Error ? err.message : String(err)",
    reason:
      "Admin-only email-config test: Resend's answer about the operator's own sender and alert address, shown to that operator.",
  },
  {
    file: "routes/email-attachments.ts",
    fragment: "error: err.message, code: err.code",
    reason:
      "Inside `instanceof FileConversionError`: every message is a fixed sentence (mail/file-conversions.ts; file-conversions-failure-text.test.ts).",
  },
  {
    file: "routes/email-feedback.ts",
    fragment: "error: err.message",
    reason:
      "Inside an `instanceof` check on a Klorn error class with a statusCode; code-written text.",
  },
  {
    file: "routes/email-replies.ts",
    fragment: "error: err.message",
    reason:
      'Inside `err.name === "UserRateLimitedError"`: billing/quota-limiter.ts\'s own sentence.',
  },
  {
    file: "routes/email-rules.ts",
    fragment: "error: err.message",
    reason: "Inside the UserRateLimitedError branch: billing/quota-limiter.ts's own sentence.",
  },
  {
    file: "routes/email.ts",
    fragment: "error: err.message",
    reason: "Inside the UserRateLimitedError branches: billing/quota-limiter.ts's own sentence.",
  },
  {
    file: "routes/sms.ts",
    fragment: "error: err.message",
    reason: "Inside `instanceof InvalidPhoneNumberError`: a code-written validation sentence.",
  },
  {
    file: "utilities.ts",
    fragment: 'err instanceof Error ? err.message : "Unknown error"',
    reason:
      "calculate()'s own expression parser throws code-written sentences (after a character whitelist); no provider or database call.",
  },
];

/** Methods whose receiver or argument is read only to classify. */
const CLASSIFIERS = new Set(["test", "includes", "startsWith", "endsWith", "has"]);
const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const TEXT_PROPERTIES = new Set(["message", "stack"]);

interface Read {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** `err`, `(err as X)`, `err!`: the expression is the caught value itself. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isTainted(node: ts.Expression, tainted: ReadonlySet<string>): boolean {
  const inner = unwrap(node);
  return ts.isIdentifier(inner) && tainted.has(inner.text);
}

/** The caught name plus locals declared as the caught value itself (`const e = err as …`). */
function aliases(caught: string, body: ts.Node): Set<string> {
  const names = new Set([caught]);
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isTainted(node.initializer, names)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return names;
}

/** A text read whose value only feeds a classification. */
function classifiesOnly(read: ts.Node): boolean {
  let node: ts.Node = read;
  // `.toLowerCase()` / `.trim()` keep the text; look at what consumes it.
  while (
    ts.isPropertyAccessExpression(node.parent) &&
    ["toLowerCase", "toUpperCase", "trim"].includes(node.parent.name.text) &&
    ts.isCallExpression(node.parent.parent)
  ) {
    node = node.parent.parent;
  }
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && COMPARISONS.has(parent.operatorToken.kind)) return true;
  if (ts.isPropertyAccessExpression(parent)) {
    if (parent.name.text === "length") return true;
    if (CLASSIFIERS.has(parent.name.text) && ts.isCallExpression(parent.parent)) return true;
  }
  if (
    ts.isCallExpression(parent) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    CLASSIFIERS.has(parent.expression.name.text) &&
    parent.arguments.some((arg) => arg === node)
  ) {
    return true;
  }
  return false;
}

/** `err.message`, `err.stack`, `String(err)`, `${err}` on a tainted name. */
function textRead(node: ts.Node, tainted: ReadonlySet<string>): boolean {
  if (ts.isPropertyAccessExpression(node) && TEXT_PROPERTIES.has(node.name.text)) {
    return isTainted(node.expression, tainted);
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    return node.expression.text === "String" && node.arguments.some((a) => isTainted(a, tainted));
  }
  if (ts.isTemplateSpan(node)) return isTainted(node.expression, tainted);
  return false;
}

function readsIn(body: ts.Node, caught: string, source: ts.SourceFile, file: string): Read[] {
  const tainted = aliases(caught, body);
  const out: Read[] = [];
  const visit = (node: ts.Node): void => {
    if (textRead(node, tainted) && !classifiesOnly(node)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      const lineText = source.text.split("\n")[line] ?? "";
      out.push({ file, line: line + 1, text: lineText.trim() });
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return out;
}

function catchHandler(node: ts.CallExpression): { caught: string; body: ts.Node } | null {
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "catch") {
    return null;
  }
  const handler = node.arguments[0];
  if (handler === undefined || !(ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
    return null;
  }
  const param = handler.parameters[0];
  if (param === undefined || !ts.isIdentifier(param.name)) return null;
  return { caught: param.name.text, body: handler.body };
}

function scan(file: string, code: string): Read[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const reads: Read[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      const declared = node.variableDeclaration.name;
      if (ts.isIdentifier(declared))
        reads.push(...readsIn(node.block, declared.text, source, file));
    }
    if (ts.isCallExpression(node)) {
      const handler = catchHandler(node);
      if (handler !== null) reads.push(...readsIn(handler.body, handler.caught, source, file));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}

const allowedFor = (read: Read) =>
  ALLOWED.find((entry) => entry.file === read.file && read.text.includes(entry.fragment));

function sourceReads(): Read[] {
  return walk(srcDir)
    .map((path) => relative(srcDir, path))
    .filter((file) => !SKIPPED_DIRS.some((dir) => file.startsWith(dir)))
    .flatMap((file) => scan(file, readFileSync(join(srcDir, file), "utf8")));
}

describe("caught error text guard", () => {
  const reads = sourceReads();

  it("no catch reads its error's text except to classify it, or as listed", () => {
    const unlisted = reads.filter((read) => allowedFor(read) === undefined);
    expect(unlisted.map((read) => `${read.file}:${read.line}: ${read.text}`)).toEqual([]);
  });

  it("every ALLOWED entry still matches a read (no stale exemptions)", () => {
    const stale = ALLOWED.filter(
      (entry) =>
        !reads.some((read) => read.file === entry.file && read.text.includes(entry.fragment)),
    );
    expect(stale.map((entry) => `${entry.file}: ${entry.fragment}`)).toEqual([]);
  });

  it("catches the shapes it guards (self-test)", () => {
    const code = `
      async function a() { try { x(); } catch (err) { return { error: err.message }; } }
      async function b() { try { x(); } catch (e) { const g = e as { message?: string }; reply.send(g.message); } }
      async function c() { p.catch((err) => store(String(err))); }
      async function d() { try { x(); } catch (err) { log(\`failed: \${err}\`); } }
      async function ok() { try { x(); } catch (err) { if (err.message === "Gmail not connected") return; if (/x/.test(err.message)) return; } }
    `;
    const found = scan("self-test.ts", code).map((read) => read.line);
    expect(found).toEqual([2, 3, 4, 5]);
  });
});
