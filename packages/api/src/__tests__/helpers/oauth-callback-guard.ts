/**
 * Source guard for OAuth callbacks: no GET route handler that verifies an
 * OAuth state may reach a credential write, directly or through the functions
 * it calls (followed by name, transitively). Account-link credentials are
 * written only after POST /api/auth/link/complete has matched the session to
 * the user who started the flow.
 *
 * Text-level on purpose, like the repo's other source guards: it reads every
 * non-test module, so a new callback file (a Drive one, say) is covered the
 * moment it exists, with no list to update.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/** A write to a table that holds an OAuth credential. */
const CREDENTIAL_WRITE =
  /\b(userToken|linkedInboxAccount|linkedCalendarAccount|linkedDriveAccount)\s*\.\s*(create|createMany|upsert|update|updateMany)\s*\(/;

/** Verifying an OAuth state: verifyToken(state) / verifiedStateOf(state) / verifyState(...). */
const VERIFIES_STATE = /\bverif\w*\s*\([^)]*\bstate\b/;

const FUNCTION_START =
  /(?:\bfunction\s+([A-Za-z_$][\w$]*)\s*\(|\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>\s*\{)/g;

/** Index just past the bracket that closes the one at `open`, skipping strings and comments. */
export function matchClose(text: string, open: number): number {
  const closer: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      i = text.indexOf("\n", i);
      if (i === -1) return text.length;
      continue;
    }
    if (ch === "/" && next === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(text, i);
      continue;
    }
    if (ch === "/" && startsRegex(text, i)) {
      i = skipRegex(text, i);
      continue;
    }
    if (ch in closer) stack.push(closer[ch] as string);
    else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return text.length;
}

/**
 * Whether the `/` at `i` opens a regex literal rather than dividing: it does
 * after an operator or an opening bracket, or after `return`/`typeof`/`case`.
 * A quote or brace inside a regex (`/"/g`, `/\d{2}/`) must not be read as
 * code, or the enclosing body is measured wrong.
 */
function startsRegex(text: string, i: number): boolean {
  const before = text.slice(Math.max(0, i - 12), i).trimEnd();
  if (before === "") return true;
  if (/(?:^|[^\w$])(?:return|typeof|case)$/.test(before)) return true;
  return "(,=:[!&|?{};+-*%<>~^".includes(before[before.length - 1] as string);
}

/** Index of the `/` that closes the regex literal opened at `start` (class `[...]` aware). */
function skipRegex(text: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "\n") return i;
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) return i;
  }
  return text.length;
}

/** Index of the quote that closes the string opened at `start` (template `${}` nesting aware). */
function skipString(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (quote === "`" && ch === "$" && text[i + 1] === "{") {
      i = matchClose(text, i + 1) - 1;
      continue;
    }
    if (ch === quote) return i;
  }
  return text.length;
}

/**
 * Where a matched function's body opens. An arrow match ends on its `{`. A
 * `function` match ends on `(`: the body is the first `{` that ends a line
 * after the parameter list (the formatter's layout), so an object type in the
 * parameters or the return type is never mistaken for it.
 */
function bodyBrace(text: string, match: RegExpMatchArray): number {
  const end = (match.index ?? 0) + match[0].length - 1;
  if (match[2] !== undefined) return end;
  const afterParams = matchClose(text, end);
  const found = /\{\r?\n/.exec(text.slice(afterParams));
  return found ? afterParams + found.index : -1;
}

/** Every named function or arrow-function body in a source, by name. */
function namedBodies(file: SourceFile): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  for (const match of file.text.matchAll(FUNCTION_START)) {
    const name = (match[1] ?? match[2]) as string;
    const brace = bodyBrace(file.text, match);
    if (brace === -1) continue;
    out.push({ name, body: file.text.slice(brace, matchClose(file.text, brace)) });
  }
  return out;
}

/** Plain calls `name(` in a text, never method calls `.name(`. */
function callsIn(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1] as string),
  );
}

/** Names of functions that (transitively, by name) satisfy `direct`. */
function closure(files: readonly SourceFile[], direct: RegExp): Set<string> {
  const bodies = files.flatMap(namedBodies);
  const found = new Set(bodies.filter((b) => direct.test(b.body)).map((b) => b.name));
  let grew = true;
  while (grew) {
    grew = false;
    for (const { name, body } of bodies) {
      if (found.has(name)) continue;
      if ([...callsIn(body)].some((called) => found.has(called))) {
        found.add(name);
        grew = true;
      }
    }
  }
  return found;
}

function reaches(text: string, direct: RegExp, names: Set<string>): boolean {
  return direct.test(text) || [...callsIn(text)].some((called) => names.has(called));
}

/** Every `app.get(...)` / `fastify.get(...)` route call in a file, as `{ route, text }`. */
export function getHandlers(file: SourceFile): Array<{ route: string; text: string }> {
  const out: Array<{ route: string; text: string }> = [];
  for (const match of file.text.matchAll(/\b(?:app|fastify|server|instance)\.get\(/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const text = file.text.slice(open, matchClose(file.text, open));
    const route = /^\(\s*["'`]([^"'`]*)["'`]/.exec(text)?.[1] ?? "?";
    out.push({ route, text });
  }
  return out;
}

/** `path GET route` for every state-verifying GET handler that reaches a credential write. */
export function oauthCallbackViolations(files: readonly SourceFile[]): string[] {
  const writers = closure(files, CREDENTIAL_WRITE);
  const verifiers = closure(files, VERIFIES_STATE);
  return files.flatMap((file) =>
    getHandlers(file)
      .filter(({ text }) => reaches(text, VERIFIES_STATE, verifiers))
      .filter(({ text }) => reaches(text, CREDENTIAL_WRITE, writers))
      .map(({ route }) => `${file.path} GET ${route}`),
  );
}

/** State-verifying GET handlers found at all (so the guard cannot pass by scanning nothing). */
export function stateVerifyingHandlers(files: readonly SourceFile[]): string[] {
  const verifiers = closure(files, VERIFIES_STATE);
  return files.flatMap((file) =>
    getHandlers(file)
      .filter(({ text }) => reaches(text, VERIFIES_STATE, verifiers))
      .map(({ route }) => `${file.path} GET ${route}`),
  );
}

/** Every non-test TypeScript module under packages/api/src. */
export function apiSourceFiles(): SourceFile[] {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "__tests__" ? [] : walk(full);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
    });
  return walk(srcDir).map((full) => ({
    path: relative(srcDir, full),
    text: readFileSync(full, "utf8"),
  }));
}
