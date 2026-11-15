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
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  calleeName,
  type ScanResult,
  scanCatches,
  type Violation,
  walk,
} from "./helpers/catch-sink-scan.js";

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

function scanSource(file: string, code: string): ScanResult {
  return scanCatches(file, code, callsLlmThrower);
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
