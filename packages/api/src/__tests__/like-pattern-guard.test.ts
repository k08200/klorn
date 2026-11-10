/**
 * Prisma sends `contains` / `startsWith` / `endsWith` to Postgres as LIKE (ILIKE
 * with `mode: "insensitive"`) and does not escape the value: `_` matches any one
 * character, `%` any run, and `\` escapes the next character. Measured on
 * Postgres 17 with the repo's Prisma: `contains: "a_b"` matches "aXb",
 * `contains: "50%"` matches "500", and `contains: "a\\b"` misses the row "a\b".
 *
 * A static scan of every source file: a value built at run time must go through
 * escapeLikePattern, and a string literal must not hold a LIKE character. A
 * SCREAMING_CASE constant is a reviewed literal and passes; keep it free of the
 * three characters too.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

const files = sourceFiles(srcDir).map((full) => ({
  path: relative(srcDir, full),
  text: readFileSync(full, "utf8"),
}));

/** A Prisma LIKE filter key, the scalar ones and the Json `string_*` ones. */
const LIKE_KEY =
  /(?<![\w$])(?:contains|startsWith|endsWith|string_contains|string_starts_with|string_ends_with)\s*:\s*/g;
/** `{ contains }`: shorthand always carries a run-time value. */
const SHORTHAND_FILTER = /[{,]\s*(contains|startsWith|endsWith)\s*[,}]/g;
const END = String.raw`\s*(?:[,}\n]|$)`;
const PLAIN_LITERAL = new RegExp(String.raw`^"[^"%_\\\n]*"${END}`);
const CONSTANT = new RegExp(String.raw`^([A-Z][A-Z0-9_]*)${END}`);
/** The whole value is one call: nothing sliced or appended after the escape. */
const ESCAPED_CALL = new RegExp(String.raw`^escapeLikePattern\((?:[^()]|\([^()]*\))*\)${END}`);

/** The string a SCREAMING_CASE constant is declared with, from any source file. */
function constantValue(name: string): string | null {
  const declared = new RegExp(String.raw`\bconst ${name}\s*=\s*"([^"]*)"`);
  for (const file of files) {
    const found = file.text.match(declared);
    if (found) return found[1];
  }
  return null;
}

function isSafeValue(rest: string): boolean {
  if (PLAIN_LITERAL.test(rest) || ESCAPED_CALL.test(rest)) return true;
  const name = rest.match(CONSTANT)?.[1];
  if (!name) return false;
  const value = constantValue(name);
  return value !== null && !/[%_\\]/.test(value);
}

/** Every LIKE filter value in the source whose shape is not one of the safe three. */
function unescapedFilters(): string[] {
  return files.flatMap((file) => {
    const keyed = [...file.text.matchAll(LIKE_KEY)]
      .map((match) => file.text.slice((match.index ?? 0) + match[0].length))
      .filter((rest) => !isSafeValue(rest))
      .map((rest) => `${file.path}: ${rest.split("\n")[0]}`);
    const shorthand = [...file.text.matchAll(SHORTHAND_FILTER)].map(
      (match) => `${file.path}: { ${match[1]} }`,
    );
    return [...keyed, ...shorthand];
  });
}

/** Source lines outside comments, so prose that says "LIKE" is not code. */
const codeLines = (text: string) =>
  text.split("\n").filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line));

describe("Prisma LIKE filters", () => {
  it("pass every run-time value through escapeLikePattern", () => {
    expect(unescapedFilters()).toEqual([]);
  });

  it("finds the filters it checks (the scan is not vacuous)", () => {
    const escaped = files.flatMap((file) =>
      [...file.text.matchAll(LIKE_KEY)].filter((match) =>
        ESCAPED_CALL.test(file.text.slice((match.index ?? 0) + match[0].length)),
      ),
    );
    expect(escaped.length).toBeGreaterThanOrEqual(20);
  });

  it("rejects an escape that is sliced or appended to afterwards", () => {
    expect(isSafeValue("escapeLikePattern(x).slice(0, 50) },")).toBe(false);
    expect(isSafeValue("escapeLikePattern(x) + tail },")).toBe(false);
    expect(isSafeValue("escapeLikePattern(JSON.stringify(args).slice(0, 50)) },")).toBe(true);
    expect(isSafeValue('"rejected_" },')).toBe(false);
    expect(isSafeValue("NO_SUCH_CONSTANT },")).toBe(false);
  });

  it("binds every raw-SQL LIKE pattern through likeContainsPattern", () => {
    const rawLike = files.flatMap((file) =>
      codeLines(file.text)
        .filter((line) => /\bI?LIKE\b/.test(line))
        .map((line) => ({ path: file.path, line: line.trim(), text: file.text })),
    );
    expect([...new Set(rawLike.map((r) => r.path))].sort()).toEqual([
      "agentcore/skill-recorder.ts",
      "judge/email-lanes.ts",
    ]);
    for (const { path, line, text } of rawLike) {
      const bound = [...line.matchAll(/\bI?LIKE\s+\$\{([^}]*)\}/g)].map((m) => m[1].trim());
      expect(bound.length, `${path}: ${line}`).toBeGreaterThan(0);
      for (const expr of bound) {
        const viaHelper =
          /^likeContainsPattern\([\w.]+\)$/.test(expr) ||
          new RegExp(String.raw`\bconst ${expr}\s*=\s*likeContainsPattern\(`).test(text);
        expect(viaHelper, `${path}: ${expr}`).toBe(true);
      }
    }
  });
});
