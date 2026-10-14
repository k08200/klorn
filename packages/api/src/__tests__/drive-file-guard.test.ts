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
const KLORN_READ_MODULE = "drive/klorn-drive-read.ts";
const EXPORT_MODULE = "drive/drive-export.ts";
const SUMMARY_SOURCE_MODULE = "drive/summary-source.ts";
const SUMMARY_STORE_MODULE = "drive/summary-store.ts";

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

  it("it writes with one upsert and one update-only call, both keyed on the row's whole identity", () => {
    const text = fileAt(ROWS_MODULE)?.text ?? "";
    const windows = callWindows(text, ROW_WRITE);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatch(
      /driveFile\.upsert\(\{\s*where: \{ driveFileIdentity: \{ userId, provider, sourceKey, externalId \} \}/,
    );
    expect(windows[0]).toMatch(/create: row\.data,/);
    // D3's rename and move: never creates, so a row deleted meanwhile stays deleted.
    expect(windows[1]).toMatch(
      /driveFile\.updateMany\(\{\s*where: \{ userId, provider, sourceKey, externalId \},\s*data: row\.changes,/,
    );
  });

  it("the row it creates always carries provider and sourceKey, from the source", () => {
    const text = fileAt(ROWS_MODULE)?.text ?? "";
    expect(text).toMatch(/\n\s+provider: source\.provider,\n\s+sourceKey: source\.sourceKey,\n/);
  });

  it("an update writes only the changes, which cannot name the identity", () => {
    const text = fileAt(ROWS_MODULE)?.text ?? "";
    const windows = callWindows(text, ROW_WRITE);
    expect(windows[0]).toMatch(/update: row\.changes,/);
    expect(windows[1]).toMatch(/data: row\.changes,/);
    const from = text.slice(text.indexOf("export interface DriveRowChanges {"));
    const changes = from.slice(0, from.indexOf("\n}"));
    expect(changes).toMatch(/readonly name: string;/);
    expect(changes).not.toMatch(/\b(userId|provider|sourceKey|externalId)\b/);
  });

  it("every field of the changes but the two a create needs is optional: an update is partial", () => {
    const text = fileAt(ROWS_MODULE)?.text ?? "";
    const from = text.slice(text.indexOf("export interface DriveRowChanges {"));
    const fields = from
      .slice(0, from.indexOf("\n}"))
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("readonly "));
    const required = fields.filter((line) => !/^readonly \w+\?:/.test(line));
    expect(required).toEqual(["readonly name: string;", "readonly modifiedAt: Date;"]);
    expect(fields.length).toBeGreaterThan(required.length);
  });

  it("the schema gives provider and sourceKey no default to fall back on", () => {
    const schema = readFileSync(join(srcDir, "..", "prisma", "schema.prisma"), "utf8");
    const model = schema.slice(schema.indexOf("model DriveFile {"));
    const body = model.slice(0, model.indexOf("\n}"));
    expect(body).toMatch(/\n\s+provider\s+DriveProvider\n/);
    expect(body).toMatch(/\n\s+sourceKey\s+String\n/);
  });

  it("only the user purge and the writer's Klorn delete delete rows", () => {
    expect(pathsWith(ROW_DELETE)).toEqual([ROWS_MODULE, "purge-user-data.ts"]);
    expect(fileAt("purge-user-data.ts")?.text).toContain("await tx.driveFile.deleteMany(scope);");
    // D3: one user's KLORN rows, by the ids D3 minted. Nothing of another source.
    const windows = callWindows(fileAt(ROWS_MODULE)?.text ?? "", ROW_DELETE);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatch(
      /driveFile\.deleteMany\(\{\s*where: \{\s*userId,\s*provider: "KLORN",\s*sourceKey: KLORN_DRIVE_SOURCE_KEY,\s*externalId: \{ in: \[\.\.\.externalIds\] \},\s*\},/,
    );
  });

  it("the Klorn drive deletes a file's object before its row", () => {
    const text = fileAt("drive/klorn-remove.ts")?.text ?? "";
    const body = text.slice(text.indexOf("export async function deleteKlornItem("));
    const objects = body.indexOf("await deleteObjects(");
    const rowsGone = body.indexOf("await deleteKlornDriveRows(");
    expect(objects).toBeGreaterThan(0);
    expect(rowsGone).toBeGreaterThan(objects);
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
    expect(pathsWith(ROW_READ)).toEqual([
      EXPORT_MODULE,
      READ_MODULE,
      KLORN_READ_MODULE,
      SUMMARY_SOURCE_MODULE,
    ]);
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
        expect(window.slice(0, 200)).toMatch(
          /\.\.\.filtersOf\(options\)|\.\.\.klornRowsOf\(userId\)|where: \{ userId \}/,
        );
      }
    }
    expect(fileAt(READ_MODULE)?.text).toContain("[{ userId: options.userId, trashed: false }]");
    expect(fileAt(KLORN_READ_MODULE)?.text).toContain(
      'return [{ userId, provider: "KLORN", sourceKey: KLORN_DRIVE_SOURCE_KEY, trashed: false }];',
    );
  });

  it("every read selects its columns: no raw row, so no storage key and no BigInt on the wire", () => {
    for (const path of pathsWith(ROW_READ)) {
      for (const window of callWindows(fileAt(path)?.text ?? "", ROW_READ)) {
        // An aggregate returns no row: it names the one sum it computes.
        if (/^driveFile\.aggregate\(/.test(window)) {
          expect(window).toMatch(/_sum: \{ sizeBytes: true \},\s*\}\);/);
          continue;
        }
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
    expect(index).toMatch(
      /app\.register\(klornDriveRoutes\(\{ gate: klornDriveRoutesEnabled \}\), \{\s*prefix: "\/api\/drive",?\s*\}\)/,
    );
    for (const path of ["routes/drive.ts", "routes/klorn-drive.ts"]) {
      expect(fileAt(path)?.text).toContain('app.addHook("onRequest", darkRouteGate(opts.gate));');
    }
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

describe("the summary tables (D4): one writer, every query names its user", () => {
  const SUMMARY_CALL =
    /\b(driveFileSummary|driveSummaryUsage)\s*\.\s*(findMany|findFirst|findUnique|count|aggregate|groupBy|create|createMany|upsert|update|updateMany|delete|deleteMany)\s*\(/g;
  const SUMMARY_WRITE =
    /\b(driveFileSummary|driveSummaryUsage)\s*\.\s*(create|createMany|upsert|update|updateMany|delete|deleteMany)\s*\(/g;
  // The user's purge deletes their rows; the store writes everything else.
  const WRITERS = ["drive/summary-store.ts", "purge-user-data.ts"];
  // The job's two queries over every user's rows, each marked `system:` in its doc.
  const SYSTEM_QUERIES = ["dueSummaries", "pruneSummaryUsage"];

  it("only the summary store writes the tables, besides the user purge", () => {
    expect(pathsWith(SUMMARY_WRITE)).toEqual(WRITERS);
    const purge = fileAt("purge-user-data.ts")?.text ?? "";
    for (const window of callWindows(purge, SUMMARY_WRITE)) {
      expect(window.slice(0, 60)).toMatch(/^\w+\.deleteMany\(scope\)/);
    }
  });

  it("every other query names the user in its where", () => {
    const callers = pathsWith(SUMMARY_CALL);
    expect(callers).toEqual([EXPORT_MODULE, "drive/summary-store.ts", "purge-user-data.ts"].sort());
    const store = fileAt(SUMMARY_STORE_MODULE)?.text ?? "";
    const functions = store.split(/\nexport async function /).slice(1);
    let scoped = 0;
    for (const fn of functions) {
      const name = fn.slice(0, fn.indexOf("("));
      for (const window of callWindows(fn, SUMMARY_CALL)) {
        if (SYSTEM_QUERIES.includes(name)) continue;
        expect(window.slice(0, 220), name).toMatch(
          /where: \{\s*(driveFileId, userId|id: row\.id, userId|id: ref\.id, userId: ref\.userId|id: row\.id, userId: row\.userId|userId_dayKey: \{ userId, dayKey \}|userId,)/,
        );
        scoped += 1;
      }
    }
    expect(scoped).toBeGreaterThanOrEqual(10);
    for (const name of SYSTEM_QUERIES) {
      expect(store).toMatch(
        new RegExp(`/\\*\\* system: [^*]*\\*/\\nexport async function ${name}\\(`),
      );
    }
    expect(fileAt(EXPORT_MODULE)?.text).toMatch(
      /driveFileSummary\.findMany\(\{\s*where: \{ userId \}/,
    );
  });

  it("the summary search escapes its text before Prisma's contains, as the name search does", () => {
    const store = fileAt(SUMMARY_STORE_MODULE)?.text ?? "";
    expect(store).toContain('summary: { contains: escapeLikePattern(text), mode: "insensitive" }');
    expect(store.match(/\bcontains:/g)).toHaveLength(1);
  });

  it("no response carries the extracted text or a storage key", () => {
    for (const path of ["routes/drive.ts", SUMMARY_STORE_MODULE, EXPORT_MODULE]) {
      expect(fileAt(path)?.text ?? "", path).not.toMatch(
        /storageKey|contentText|extractSummaryText/,
      );
    }
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
  // model: its path and the pattern that shows the wrap. D4's summariser is the
  // only one; drive-summary-llm.test.ts proves the wrap on what is sent.
  const LLM_FACING: Array<[string, RegExp]> = [
    [
      "drive/summary-llm.ts",
      /wrapUntrusted\(input\.name, "drive:name"\)[\s\S]*wrapUntrusted\(input\.mimeType \?\? "unknown", "drive:type"\)[\s\S]*wrapUntrusted\(input\.text, "drive:text"\)/,
    ],
  ];
  // Modules that hold drive rows and never touch an LLM, directly or by a
  // dynamic import.
  const NOT_LLM_FACING = [
    "drive/drive-export.ts",
    "drive/drive-providers.ts",
    "drive/drive-read.ts",
    "drive/drive-rows.ts",
    "drive/drive-scope.ts",
    "drive/klorn-content-type.ts",
    "drive/klorn-drive-read.ts",
    "drive/klorn-errors.ts",
    "drive/klorn-file-name.ts",
    "drive/klorn-quota.ts",
    "drive/klorn-remove.ts",
    "drive/klorn-tree.ts",
    "drive/klorn-upload.ts",
    "drive/providers/dispatch.ts",
    "drive/providers/types.ts",
    "drive/providers/unsupported.ts",
    "drive/summary-bytes.ts",
    "drive/summary-extract.ts",
    "drive/summary-job.ts",
    "drive/summary-policy.ts",
    // Hands the name and text to summary-llm.ts, which wraps them.
    "drive/summary-run.ts",
    "drive/summary-source.ts",
    "drive/summary-store.ts",
    // Loads summary-run.ts on demand; imports nothing from the LLM itself.
    "drive/summary-triggers.ts",
    "purge-user-data.ts",
    "routes/drive.ts",
    "routes/klorn-drive.ts",
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
    expect(driveImports).toEqual([
      "./drive/drive-export.js",
      "./routes/drive.js",
      "./routes/klorn-drive.js",
    ]);
    expect(text.match(/\bexportDriveFiles\(/g)).toHaveLength(1);
    expect(text.match(/\bdriveRoutes\(/g)).toHaveLength(1);
    expect(text.match(/\bklornDriveRoutes\(/g)).toHaveLength(1);
    expect(text.match(/\bdriveFiles\b/g)).toHaveLength(2);
  });

  it("an LLM-facing module wraps the drive text it sends", () => {
    for (const [path, pattern] of LLM_FACING) {
      const text = fileAt(path)?.text ?? "";
      expect(text).toMatch(pattern);
      expect(text).toContain("wrapUntrusted(");
    }
    expect(LLM_FACING.map(([path]) => path)).toEqual(["drive/summary-llm.ts"]);
  });

  it("only the summariser imports the LLM among the drive modules", () => {
    const importers = files
      .filter((f) => f.path.startsWith("drive/") && llmSpecifiers(f.text).length > 0)
      .map((f) => f.path);
    expect(importers).toEqual(["drive/summary-llm.ts"]);
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
