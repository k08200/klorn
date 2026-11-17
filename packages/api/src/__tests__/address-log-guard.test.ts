/**
 * Across packages/api/src, no mail address goes to the console, a pino logger
 * or Sentry by name.
 *
 * An address is personal data, and logs and Sentry keep it beyond the account:
 * a data wipe or an account deletion never reaches them. A line that needs to
 * say which account names its row id; one with no row (an address nothing
 * matched) uses addressLogTag (security/address-log-tag.ts), a keyed tag.
 *
 * The check is by name: a value called `email`, `address`, `recipient`,
 * `calendarId`, `user.email`, `fromAddress`, … handed to a sink (console.*,
 * request.log.*, captureError / Sentry.*, a failure reporter's ids / extra),
 * directly, in a template, as the receiver of a method (`email.trim()`), or
 * under an address key (`{ email: login }`) unless addressLogTag reduced it.
 * A field read off it (`email.id`, `email.gmailId`) is a different value and
 * is not flagged. An address that travels under another name (a calendar id
 * inside `reasons`) is outside what a name check can see; those sites have
 * tests next to their features (calendar-conflicts.test.ts).
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { calleeName, sinkArguments, walk } from "./helpers/catch-sink-scan.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..");

/** Names that hold an address (or a list of them). Counts such as `totalEmails` do not match. */
const ADDRESS_NAME =
  /^(email|emails|emailAddress|emailAddresses|emailLower|address|addresses|addr|mailbox|recipient|recipients|sender|senders|from|to|cc|ccs|bcc|replyTo|attendee|attendees|organizer|participants|calendarId|calendarIds)$|[a-z](Email|EmailAddress|Address|Addresses|Addr|Recipient|Recipients|Sender|Attendees)$/;

/** Calls that may take an address: their result carries none of it. */
const ADDRESS_SANITIZERS = new Set(["addressLogTag"]);

/** Directories whose output is the operator's own terminal. */
const OPERATOR_ONLY_DIRS: ReadonlyArray<{ dir: string; reason: string }> = [
  {
    dir: "scripts/",
    reason:
      "Operator CLIs run by hand (`tsx src/scripts/<name>.ts`) to look accounts up by address; no server module imports them (db-failure-redaction-guard.test.ts checks), and they import no Sentry.",
  },
];

/**
 * Single sinks that may carry part of an address. Matched by file, by a
 * fragment that includes the reduction itself (so swapping it for the raw
 * value fails), and by exactly the names found.
 */
const ALLOWED: ReadonlyArray<{
  file: string;
  fragment: string;
  names: readonly string[];
  reason: string;
}> = [
  {
    file: "pim/linked-calendar-failure.ts",
    fragment: 'accountDomain: email.split("@")[1]',
    names: ["email"],
    reason: "The domain only, to tell providers apart in Sentry.",
  },
];

/** Files the scan must see sinks in, so a moved file cannot pass vacuously. */
const MUST_SEE = [
  "routes/gmail-push.ts",
  "routes/google-link-finish.ts",
  "routes/auth.ts",
  "pim/calendar-providers/google.ts",
  "mail/email.ts",
] as const;

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly names: readonly string[];
  readonly text: string;
}

/** A call to an address sanitizer: what it returns carries none of the address. */
function isReduced(expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr)) return false;
  const name = calleeName(expr);
  return name !== null && ADDRESS_SANITIZERS.has(name);
}

/** Address-named values in `expr`, by the text that names them. */
function addressValues(expr: ts.Node): string[] {
  if (ts.isIdentifier(expr)) return ADDRESS_NAME.test(expr.text) ? [expr.text] : [];
  if (ts.isShorthandPropertyAssignment(expr)) {
    return ADDRESS_NAME.test(expr.name.text) ? [expr.name.text] : [];
  }
  // `user.email` is an address; `email.id` is the row's id, a different value.
  if (ts.isPropertyAccessExpression(expr)) {
    return ADDRESS_NAME.test(expr.name.text) ? [expr.getText()] : [];
  }
  // `{ email: x }` says what x is, whatever x is called, unless x is reduced.
  if (ts.isPropertyAssignment(expr)) {
    const key = ts.isIdentifier(expr.name) || ts.isStringLiteral(expr.name) ? expr.name.text : "";
    if (!ADDRESS_NAME.test(key) || isReduced(expr.initializer)) {
      return addressValues(expr.initializer);
    }
    return [`${key}:`];
  }
  if (ts.isCallExpression(expr)) {
    const name = calleeName(expr);
    if (name !== null && ADDRESS_SANITIZERS.has(name)) return [];
    const args = expr.arguments.flatMap((arg) => addressValues(arg));
    // A method on an address (`email.trim()`, `to.split("@")`) still carries it.
    const callee = expr.expression;
    return ts.isPropertyAccessExpression(callee)
      ? [...args, ...addressValues(callee.expression)]
      : args;
  }
  const out: string[] = [];
  ts.forEachChild(expr, (child) => {
    out.push(...addressValues(child));
  });
  return out;
}

function scanFile(file: string, code: string): { findings: Finding[]; sinks: number } {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: Finding[] = [];
  let sinks = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const args = sinkArguments(node);
      if (args.length > 0) sinks += 1;
      const names = args.flatMap((arg) => addressValues(arg));
      if (names.length > 0) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        findings.push({
          file,
          line: line + 1,
          names,
          text: node.getText(source).replace(/\s+/g, " "),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { findings, sinks };
}

function isAllowed(f: Finding): boolean {
  return (
    OPERATOR_ONLY_DIRS.some((d) => f.file.startsWith(d.dir)) ||
    ALLOWED.some(
      (a) =>
        a.file === f.file &&
        f.text.includes(a.fragment) &&
        a.names.length === f.names.length &&
        a.names.every((name, i) => f.names[i] === name),
    )
  );
}

describe("address log guard (all of packages/api/src)", () => {
  const scans = walk(srcDir).map((full) => {
    const file = relative(srcDir, full).split("\\").join("/");
    return { file, ...scanFile(file, readFileSync(full, "utf8")) };
  });
  const findings = scans.flatMap((s) => s.findings);

  it("finds no address handed to the console, a logger or Sentry", () => {
    const offenders = findings
      .filter((f) => !isAllowed(f))
      .map((f) => `${f.file}:${f.line} [${f.names.join(", ")}] ${f.text.slice(0, 160)}`);
    expect(offenders).toEqual([]);
  });

  it("cannot pass vacuously: it sees sinks across the tree and in the files that handle addresses", () => {
    const total = scans.reduce((sum, s) => sum + s.sinks, 0);
    expect(total).toBeGreaterThan(1000);
    for (const place of MUST_SEE) {
      const seen = scans.find((s) => s.file === place)?.sinks ?? 0;
      expect(seen, place).toBeGreaterThan(0);
    }
  });

  it("keeps every allowlist entry live", () => {
    for (const entry of ALLOWED) {
      const live = findings.some(
        (f) => isAllowed(f) && f.file === entry.file && f.text.includes(entry.fragment),
      );
      expect(live, `${entry.file}: ${entry.fragment}`).toBe(true);
    }
  });
});

describe("the address guard itself", () => {
  const scanned = (body: string) =>
    scanFile("bad.ts", `async function f(user, email, linked, row) { ${body} }`).findings;

  it.each([
    ["an address in a template", "console.warn(`[X] no inbox for ${email}, draining`);"],
    ["a user's address", "console.warn(`[X] refusing for ${user.email}`);"],
    ["a method on an address", "console.log('[X]', email.trim().toLowerCase());"],
    ["an address in pino", "request.log.warn({ email }, 'x');"],
    ["an address under another key in pino", "app.log.info({ who: linked.emailAddress }, 'x');"],
    [
      "an address in Sentry extra",
      "captureError(new Error('x'), { tags: { scope: 'x' }, extra: { calendarId: row.calendarId } });",
    ],
    ["an address in a reporter's ids", "logDbFailure('[X] failed', err, { ids: { to } });"],
    ["a suffixed name", "console.error('[X]', fromAddress);"],
    ["a value under an address key", "request.log.warn({ email: row.login }, 'x');"],
    ["a reduced address under a short name", "console.log('[X] sent to', safeAddr);"],
  ])("flags %s", (_label, body) => {
    expect(scanned(body)).toHaveLength(1);
  });

  it.each([
    ["the keyed tag", "console.warn(`[X] no inbox for ${addressLogTag(email)}`);"],
    ["the keyed tag under an address key", "request.log.warn({ email: addressLogTag(e) }, 'x');"],
    ["the row id", "console.warn(`[X] refusing for user ${user.id}`);"],
    ["a field of an email row", "console.log(`[X] skipped ${email.gmailId} (${email.id})`);"],
    ["a count", "console.log(`[X] ${totalEmails} total`);"],
    ["a reporter's label and failure", "logDbFailure('[X] failed', email);"],
    ["a call that is not a sink", "await send(email);"],
  ])("accepts %s", (_label, body) => {
    expect(scanned(body)).toEqual([]);
  });
});
