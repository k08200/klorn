/**
 * Who may ring the interrupt push bucket (push-bucket.ts).
 *
 * The interrupt bucket is the room urgent mail, meeting alerts and reminders
 * the user set need to reach the device. Anything else that rings it can crowd
 * them out, which is what the agent did before the bucket became the caller's
 * choice: its notify_user sent email_urgent and meeting, and those categories
 * used to pick the bucket.
 *
 * Interrupt is opt-in per call (`{ bucket: "interrupt" }`; the default is
 * ambient), so this scan can see every way into it. It parses each module that
 * calls sendPushNotification and fails when:
 *   - a module not listed in INTERRUPT_CALLERS asks for interrupt, or a listed
 *     one asks for it from a call (category) that is not listed;
 *   - a call passes options the scan cannot read (a variable, a spread, a
 *     computed bucket), since that would hide an interrupt request;
 *   - a call whose category looks urgent (email_urgent, meeting, or computed)
 *     leaves the bucket out: it must say which one it means, so a new urgent
 *     path cannot silently ring ambient, nor an agent path silently interrupt;
 *   - an agent-originated push (LLM- or heuristic-decided: AGENT_DIRS) does not
 *     state `bucket: "ambient"` explicitly;
 *   - sendPushNotification is referenced other than by a direct call, a
 *     same-name import or destructuring, or its declaration (an alias, a
 *     re-export, a callback, `.call`, `obj["…"]` would hide calls from the
 *     scan), or something other than push.ts reaches the limiter.
 *
 * A new interrupt caller is a product decision: add it here with the reason,
 * and to push-bucket.ts and docs/design/attention-engine-v3.md.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Module → the categories of its calls that may ask for interrupt. */
const INTERRUPT_CALLERS: Record<string, string[]> = {
  // The firewall's PUSH and MEETING mail (v2 path, and v3 PUSH under the budget).
  "judge/firewall-push.ts": ["email_urgent"],
  // The urgent keyword sweep (users the v3 policy does not cover).
  "automation-scheduler.ts": ["email_urgent"],
  // "Meeting in N min".
  "background.ts": ["meeting"],
  // Reminders the user set for a time.
  "pim/reminder-scheduler.ts": ["system"],
};

/** Agent-originated pushes live here; each must say bucket: "ambient". */
const AGENT_DIRS = ["agentcore/", "agent/", "mcp/"];

/** Categories that read as urgent: a call using one must state its bucket. */
const URGENT_LOOKING = new Set(["email_urgent", "meeting", "<computed>"]);

const PUSH_FN = "sendPushNotification";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

const files = sourceFiles(srcDir).map((full) => ({
  path: relative(srcDir, full).split("\\").join("/"),
  text: readFileSync(full, "utf8"),
}));

type Bucket = "interrupt" | "ambient" | "default" | "unreadable";

interface PushCall {
  where: string;
  category: string;
  bucket: Bucket;
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function literal(expr: ts.Expression | undefined): string | null {
  if (!expr) return null;
  return ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr) ? expr.text : null;
}

/**
 * Whether this mention of sendPushNotification is one the scan accounts for:
 * a direct call, the declaration, or a same-name import / destructuring.
 */
function isAccountedReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isCallExpression(parent) && parent.expression === node) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
  }
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true;
  if (ts.isImportSpecifier(parent) || ts.isBindingElement(parent)) {
    const imported = parent.propertyName?.getText() ?? parent.name.getText();
    return imported === PUSH_FN && parent.name.getText() === PUSH_FN;
  }
  return false;
}

/** The bucket a call asks for, or "unreadable" when the scan cannot tell. */
function bucketOf(options: ts.Expression | undefined): Bucket {
  if (!options) return "default";
  if (!ts.isObjectLiteralExpression(options) || options.properties.length !== 1) {
    return "unreadable";
  }
  const [prop] = options.properties;
  if (!prop || !ts.isPropertyAssignment(prop) || prop.name.getText() !== "bucket") {
    return "unreadable";
  }
  const value = literal(prop.initializer);
  return value === "interrupt" || value === "ambient" ? value : "unreadable";
}

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function pushCallsIn(path: string, text: string): PushCall[] {
  const source = parse(path, text);
  const calls: PushCall[] = [];
  walk(source, (node) => {
    if (!ts.isCallExpression(node) || calleeName(node.expression) !== PUSH_FN) return;
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const [, , category, options] = node.arguments;
    const spread = node.arguments.some((arg) => ts.isSpreadElement(arg));
    calls.push({
      where: `${path}:${line}`,
      // No category argument means the "system" default.
      category: category ? (literal(category) ?? "<computed>") : "system",
      bucket: spread || node.arguments.length > 4 ? "unreadable" : bucketOf(options),
    });
  });
  return calls;
}

const pushCalls = files
  .filter((f) => f.text.includes(PUSH_FN))
  .flatMap((f) => pushCallsIn(f.path, f.text).map((call) => ({ ...call, path: f.path })));

describe("who may ring the interrupt push bucket", () => {
  it("finds push calls across the codebase (so this guard cannot pass by scanning nothing)", () => {
    const modules = new Set(pushCalls.map((c) => c.path));
    for (const path of [...Object.keys(INTERRUPT_CALLERS), "agentcore/autonomous-agent.ts"]) {
      expect(modules).toContain(path);
    }
  });

  it("every call's options are a literal { bucket } the scan can read, or absent", () => {
    const unreadable = pushCalls.filter((c) => c.bucket === "unreadable").map((c) => c.where);
    expect(unreadable).toEqual([]);
  });

  it("only the pinned callers ask for interrupt, each from its pinned category", () => {
    const asked: Record<string, string[]> = {};
    for (const call of pushCalls.filter((c) => c.bucket === "interrupt")) {
      asked[call.path] = [...(asked[call.path] ?? []), call.category];
    }
    expect(asked).toEqual(INTERRUPT_CALLERS);
  });

  it("every call with an urgent-looking or computed category states its bucket", () => {
    const silent = pushCalls
      .filter((c) => URGENT_LOOKING.has(c.category) && c.bucket === "default")
      .map((c) => c.where);
    expect(silent).toEqual([]);
  });

  it('every agent-originated push states bucket: "ambient", whatever its category', () => {
    const agentCalls = pushCalls.filter((c) => AGENT_DIRS.some((dir) => c.path.startsWith(dir)));
    expect(agentCalls.length).toBeGreaterThan(0);
    const notAmbient = agentCalls.filter((c) => c.bucket !== "ambient").map((c) => c.where);
    expect(notAmbient).toEqual([]);
  });

  it("sendPushNotification is only ever called directly, never aliased or passed around", () => {
    const hidden: string[] = [];
    for (const file of files.filter((f) => f.text.includes(PUSH_FN))) {
      const source = parse(file.path, file.text);
      walk(source, (node) => {
        const where = () => {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          return `${file.path}:${line}`;
        };
        if (ts.isIdentifier(node) && node.text === PUSH_FN && !isAccountedReference(node)) {
          hidden.push(where());
        }
        if (ts.isElementAccessExpression(node) && literal(node.argumentExpression) === PUSH_FN) {
          hidden.push(where());
        }
      });
    }
    expect(hidden).toEqual([]);
  });

  it("only push.ts reaches the push rate limiter, and only the limiter writes its rows", () => {
    const limiterUsers = files
      .filter((f) => f.text.includes("recordPushAttempt"))
      .map((f) => f.path)
      .sort();
    expect(limiterUsers).toEqual(["notify/push-rate-limit.ts", "notify/push.ts"]);

    const ringWriters = files
      .filter((f) =>
        /\bpushRingEvent\s*\.\s*(create|createMany|upsert|update|updateMany)\b/.test(f.text),
      )
      .map((f) => f.path);
    expect(ringWriters).toEqual(["notify/push-rate-limit.ts"]);
  });
});
