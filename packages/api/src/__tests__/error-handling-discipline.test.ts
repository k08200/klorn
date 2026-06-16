import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guardrail for sub-project C: ban *silent, empty* catch blocks.
 *
 * biome's noEmptyBlockStatements intentionally exempts catch clauses, so it
 * can't enforce this. A truly-empty `catch {}` / `catch (e) {}` swallows an
 * error with zero signal — a real failure becomes invisible in prod. A catch
 * that legitimately ignores an error must say WHY: a comment inside the braces
 * (`catch { // reason }`) makes the block non-empty and passes, turning every
 * swallow into a documented, conscious decision.
 *
 * This does NOT require logging in every catch (many are valid control flow) —
 * only that the block is not literally empty.
 *
 * Detection is line-based: comment lines, block comments, and inline
 * backtick/`//` code-in-prose are skipped so a `catch {}` *mentioned in a
 * comment* isn't a false positive, while a real `catch {}` on a code line is
 * flagged and a catch with a comment between the braces passes.
 */

const SRC = join(__dirname, "..");
const EMPTY_CATCH = /\bcatch\s*(\([^)]*\)\s*)?\{\s*\}/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      out.push(...tsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function emptyCatchLines(text: string): number[] {
  const hits: number[] = [];
  const lines = text.split("\n");
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
    // Code line — drop trailing line-comment and inline backtick code-in-prose.
    const code = lines[i].replace(/\/\/.*$/, "").replace(/`[^`]*`/g, "");
    if (EMPTY_CATCH.test(code)) hits.push(i + 1);
  }
  return hits;
}

describe("error-handling discipline", () => {
  it("has no silent, empty catch blocks in packages/api/src", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const lines = emptyCatchLines(readFileSync(file, "utf8"));
      for (const line of lines) offenders.push(`${file.replace(SRC, "src")}:${line}`);
    }
    // An empty catch must carry a comment explaining why the error is safe to
    // drop. If this fails, add `// <reason>` inside the catch (or handle it).
    expect(offenders).toEqual([]);
  });

  it("flags a real empty catch and allows a commented one (self-test)", () => {
    expect(emptyCatchLines("try { x() } catch {}")).toEqual([1]);
    expect(emptyCatchLines("try { x() } catch (e) {}")).toEqual([1]);
    expect(emptyCatchLines("try { x() } catch { /* expected */ }")).toEqual([]);
    expect(emptyCatchLines(" * a bare `catch {}` in a JSDoc line")).toEqual([]);
    expect(emptyCatchLines("// inline catch {} mention")).toEqual([]);
  });
});
