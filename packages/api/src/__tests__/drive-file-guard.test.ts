/**
 * D2 guard (mirrors calendar-provider-writers-guard.test.ts). A static scan of
 * every source file, so a new DriveFile writer or reader cannot land unnoticed:
 *
 *   - a row is written in exactly one place (drive/drive-rows.ts), which states
 *     provider and sourceKey and cleans what an external drive sent;
 *   - every read goes through the kill switch (driveSourceScope in the `where`
 *     of a list, isDriveRowVisible on a row fetched by id), is scoped to one
 *     user, and returns an explicit `select` (no storage key, no raw BigInt);
 *   - nothing queries the table with raw SQL;
 *   - a file name is attacker-controlled text. A module that reads drive rows
 *     and reaches the LLM must wrap the name in `wrapUntrusted`, and say so here.
 *
 * A module that fails the "accounted for" tests is new: decide which list it
 * belongs to.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROWS_MODULE = "drive/drive-rows.ts";
const READ_MODULE = "drive/drive-read.ts";
const EXPORT_MODULE = "drive/drive-export.ts";

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

const fileAt = (path: string) => files.find((f) => f.path === path);

/** The text of each call to `pattern`, up to the next statement-ish boundary. */
function callWindows(text: string, pattern: RegExp): string[] {
  const windows: string[] = [];
  for (const match of text.matchAll(pattern)) {
    windows.push(text.slice(match.index ?? 0, (match.index ?? 0) + 500));
  }
  return windows;
}

const pathsWith = (pattern: RegExp) =>
  files
    .filter((f) => callWindows(f.text, pattern).length > 0)
    .map((f) => f.path)
    .sort();

const ROW_WRITE =
  /\bdriveFile\s*\.\s*(create|createMany|createManyAndReturn|upsert|update|updateMany)\s*\(/g;
const ROW_DELETE = /\bdriveFile\s*\.\s*(delete|deleteMany)\s*\(/g;
const ROW_READ =
  /\bdriveFile\s*\.\s*(findMany|findFirst|findUnique|count|aggregate|groupBy|findFirstOrThrow|findUniqueOrThrow)\s*\(/g;
const LIST_READ =
  /\bdriveFile\s*\.\s*(findMany|findFirst|count|aggregate|groupBy|findFirstOrThrow)\s*\(/g;
const BY_ID_READ = /\bdriveFile\s*\.\s*(findUnique|findUniqueOrThrow)\s*\(/g;

describe("every DriveFile write states its source, in one place", () => {
  it("the rows module is the only writer", () => {
    expect(pathsWith(ROW_WRITE)).toEqual([ROWS_MODULE]);
  });

  it("it writes with exactly one upsert, keyed on the row's whole identity", () => {
    const text = fileAt(ROWS_MODULE)?.text ?? "";
    const windows = callWindows(text, ROW_WRITE);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatch(
      /driveFile\.upsert\(\{\s*where: \{ driveFileIdentity: \{ userId: owner, provider, sourceKey, externalId \} \}/,
    );
    expect(windows[0]).toMatch(/create: row\.data,/);
  });

  it("the row it creates always carries provider and sourceKey, from the source", () => {
    const text = fileAt(ROWS_MODULE)?.text ?? "";
    expect(text).toMatch(/\n\s+provider: source\.provider,\n\s+sourceKey: source\.sourceKey,\n/);
  });

  it("an update never rewrites the identity", () => {
    const text = fileAt(ROWS_MODULE)?.text ?? "";
    expect(text).toContain(
      "const { userId: owner, provider, sourceKey, externalId, ...metadata } = row.data;",
    );
    expect(text).toMatch(/update: metadata,/);
  });

  it("the schema gives provider and sourceKey no default to fall back on", () => {
    const schema = readFileSync(join(srcDir, "..", "prisma", "schema.prisma"), "utf8");
    const model = schema.slice(schema.indexOf("model DriveFile {"));
    const body = model.slice(0, model.indexOf("\n}"));
    expect(body).toMatch(/\n\s+provider\s+DriveProvider\n/);
    expect(body).toMatch(/\n\s+sourceKey\s+String\n/);
  });

  it("only the user purge deletes rows", () => {
    expect(pathsWith(ROW_DELETE)).toEqual(["purge-user-data.ts"]);
    expect(fileAt("purge-user-data.ts")?.text).toContain("await tx.driveFile.deleteMany(scope);");
  });

  it("no module outside the drive modules names the row's unique key", () => {
    const keyed = files.filter((f) => f.text.includes("driveFileIdentity")).map((f) => f.path);
    expect(keyed).toEqual([ROWS_MODULE]);
  });
});

describe("every DriveFile read goes through the kill switch", () => {
  // The export returns every row the system holds for the user, on purpose: a flag
  // hides a row from the product, not from its owner's data export.
  const EXEMPT_FROM_KILL_SWITCH = [EXPORT_MODULE];

  it("finds the known readers (so this guard cannot pass by scanning nothing)", () => {
    expect(pathsWith(ROW_READ)).toEqual([EXPORT_MODULE, READ_MODULE]);
  });

  const scoped = pathsWith(ROW_READ).filter((path) => !EXEMPT_FROM_KILL_SWITCH.includes(path));

  it.each(scoped)("%s puts driveSourceScope() in every list, count and first-row query", (path) => {
    const windows = callWindows(fileAt(path)?.text ?? "", LIST_READ);
    for (const window of windows) {
      // Inside an AND, never spread: a caller's own `provider` filter must not
      // replace the scope's.
      expect(window.slice(0, 200)).toMatch(/where: \{ AND: \[driveSourceScope\(providerEnabled\),/);
    }
  });

  it.each(scoped)("%s checks isDriveRowVisible() on every row it fetches by id", (path) => {
    const text = fileAt(path)?.text ?? "";
    const byId = callWindows(text, BY_ID_READ);
    for (const window of byId) {
      expect(window).toMatch(/!isDriveRowVisible\(row, providerEnabled\)\) return null;/);
    }
    expect(byId.length).toBeGreaterThan(0);
  });

  it("every read names the user in the query itself", () => {
    for (const path of pathsWith(ROW_READ)) {
      const text = fileAt(path)?.text ?? "";
      for (const window of callWindows(text, BY_ID_READ)) {
        expect(window.slice(0, 120)).toMatch(/where: \{ id, userId \}/);
      }
      for (const window of callWindows(text, LIST_READ)) {
        expect(window.slice(0, 200)).toMatch(/\.\.\.filtersOf\(options\)|where: \{ userId \}/);
      }
    }
    expect(fileAt(READ_MODULE)?.text).toContain("[{ userId: options.userId, trashed: false }]");
  });

  it("every read selects its columns: no raw row, so no storage key and no BigInt on the wire", () => {
    for (const path of pathsWith(ROW_READ)) {
      for (const window of callWindows(fileAt(path)?.text ?? "", ROW_READ)) {
        expect(window).toMatch(/\bselect: /);
      }
    }
    const select = (fileAt(READ_MODULE)?.text ?? "").match(
      /export const DRIVE_WIRE_SELECT = \{([^}]*)\}/,
    );
    expect(select?.[1]).toBeDefined();
    expect(select?.[1]).not.toContain("storageKey");
    expect(fileAt(EXPORT_MODULE)?.text).not.toMatch(/storageKey:/);
  });

  it("the data export reads through the export module, and the purge deletes the rows", () => {
    const index = fileAt("index.ts")?.text ?? "";
    expect(index).toContain("exportDriveFiles(userId),");
    expect(index).toMatch(/\n\s+driveFiles,\n/);
    expect(index).not.toMatch(/\bdriveFile\s*\./);
  });

  it("the routes are registered behind the flag", () => {
    const index = fileAt("index.ts")?.text ?? "";
    expect(index).toMatch(
      /app\.register\(driveRoutes\(\{ gate: driveEnabled \}\), \{\s*prefix: "\/api\/drive",?\s*\}\)/,
    );
    expect(fileAt("routes/drive.ts")?.text).toContain(
      'app.addHook("onRequest", darkRouteGate(opts.gate));',
    );
  });
});

describe("no raw SQL touches the table: every query is built by Prisma, so every value is a bind parameter", () => {
  it("no source file names the table in a raw statement", () => {
    const raw = files
      .filter((f) => /\$(queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe)\b/.test(f.text))
      .filter((f) => /\bDriveFile\b/.test(f.text))
      .map((f) => f.path);
    expect(raw).toEqual([]);
  });

  it("the drive modules use no raw statement at all", () => {
    const raw = files
      .filter((f) => f.path.startsWith("drive/") || f.path === "routes/drive.ts")
      .filter((f) => /\$(queryRaw|executeRaw)|Prisma\.sql|Prisma\.raw/.test(f.text))
      .map((f) => f.path);
    expect(raw).toEqual([]);
  });

  it("the name search escapes its text before Prisma's contains", () => {
    const text = fileAt(READ_MODULE)?.text ?? "";
    expect(text).toContain('{ contains: escapeLikePattern(text), mode: "insensitive" }');
    expect(text.match(/\bcontains:/g)).toHaveLength(1);
  });
});

describe("drive text reaches an LLM only wrapped", () => {
  // Every module that can hold a DriveFile row or a provider's file: it queries
  // the table, or imports a drive module.
  const DRIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*)["'][^"']*\/drive\/[^"']+["']/;
  const consumers = files
    .filter(
      (f) =>
        f.path.startsWith("drive/") || /\bdriveFile\b/.test(f.text) || DRIVE_IMPORT.test(f.text),
    )
    .map((f) => f.path)
    .sort();

  // A module that puts a file's name (or any other drive text) in front of a
  // model: its path and the pattern that shows the wrap. None exists in D2. D4
  // (summaries) adds the first; the entry is its obligation.
  const LLM_FACING: Array<[string, RegExp]> = [];
  // Modules that hold drive rows and never touch an LLM, directly or by a
  // dynamic import.
  const NOT_LLM_FACING = [
    "drive/drive-export.ts",
    "drive/drive-providers.ts",
    "drive/drive-read.ts",
    "drive/drive-rows.ts",
    "drive/drive-scope.ts",
    "drive/providers/dispatch.ts",
    "drive/providers/types.ts",
    "drive/providers/unsupported.ts",
    "purge-user-data.ts",
    "routes/drive.ts",
  ];
  // The server entry point imports the LLM for its own startup reporting, so its
  // imports say nothing. What it does with drive code is pinned instead: it
  // registers the routes and returns the export's result to its owner.
  const ENTRY_POINT = "index.ts";

  /** Every static or dynamic import specifier that reaches the LLM client or its helpers. */
  function llmSpecifiers(text: string): string[] {
    const found = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g)].map(
      (match) => match[1] ?? "",
    );
    return found.filter((spec) => /(^|\/)llm\//.test(spec));
  }

  it("every module that holds drive rows is accounted for", () => {
    const accounted = new Set([
      ...LLM_FACING.map(([path]) => path),
      ...NOT_LLM_FACING,
      ENTRY_POINT,
    ]);
    expect(consumers.filter((path) => !accounted.has(path))).toEqual([]);
  });

  it("the lists name no module that has stopped holding drive rows", () => {
    const listed = [...LLM_FACING.map(([path]) => path), ...NOT_LLM_FACING, ENTRY_POINT];
    expect(listed.filter((path) => !consumers.includes(path))).toEqual([]);
  });

  it.each(NOT_LLM_FACING)("%s imports nothing from the LLM, statically or dynamically", (path) => {
    const text = fileAt(path)?.text ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(llmSpecifiers(text)).toEqual([]);
    expect(text).not.toMatch(/createCompletion/);
  });

  it("the entry point only registers the routes and returns the export", () => {
    const text = fileAt(ENTRY_POINT)?.text ?? "";
    const driveImports = [...text.matchAll(/from "(\.\/[^"]*drive[^"]*)"/g)]
      .map((match) => match[1])
      .sort();
    expect(driveImports).toEqual(["./drive/drive-export.js", "./routes/drive.js"]);
    expect(text.match(/\bexportDriveFiles\(/g)).toHaveLength(1);
    expect(text.match(/\bdriveRoutes\(/g)).toHaveLength(1);
    expect(text.match(/\bdriveFiles\b/g)).toHaveLength(2);
  });

  it("an LLM-facing module wraps the drive text it sends (none in D2)", () => {
    for (const [path, pattern] of LLM_FACING) {
      const text = fileAt(path)?.text ?? "";
      expect(text).toMatch(pattern);
      expect(text).toContain("wrapUntrusted(");
    }
    expect(LLM_FACING).toEqual([]);
  });

  it("the detector sees a static import, a dynamic import and a drive import (so the lists cannot go stale silently)", () => {
    expect(llmSpecifiers('const x = await import("../llm/llm-json.js");')).toEqual([
      "../llm/llm-json.js",
    ]);
    expect(llmSpecifiers('import { a } from "../llm/model-fallback.js";')).toEqual([
      "../llm/model-fallback.js",
    ]);
    expect(llmSpecifiers('import { z } from "../drive/drive-read.js";')).toEqual([]);
    expect(DRIVE_IMPORT.test('import { listFiles } from "../drive/drive-read.js";')).toBe(true);
    expect(DRIVE_IMPORT.test('const m = await import("./drive/drive-export.js");')).toBe(true);
    expect(DRIVE_IMPORT.test('import { x } from "../pim/calendar-read.js";')).toBe(false);
  });
});
