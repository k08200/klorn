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
const ACCOUNTS_MODULE = "drive/linked-drive-accounts.ts";

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

  it("the row it creates derives sourceAccountId from the source, in one place (D5a)", () => {
    const text = fileAt(ROWS_MODULE)?.text ?? "";
    // The account a connected row came from is its sourceKey; a Klorn row has
    // none. The migration's two CHECKs hold the same rule in the database.
    expect(text).toMatch(
      /\n\s+sourceKey: source\.sourceKey,\n\s+sourceAccountId: klornHeld \? null : source\.sourceKey,\n/,
    );
    expect(text).toMatch(/\n\s+readonly sourceAccountId: string \| null;\n/);
    // A caller cannot choose it: neither the source nor the input it passes has the field.
    for (const name of ["DriveFileSource", "DriveFileInput"]) {
      const from = text.slice(text.indexOf(`export interface ${name} {`));
      expect(from.length, name).toBeLessThan(text.length);
      expect(from.slice(0, from.indexOf("\n}")), name).not.toMatch(/\bsourceAccountId\b/);
    }
  });

  it("an update writes only the changes, which cannot name the identity", () => {
    const text = fileAt(ROWS_MODULE)?.text ?? "";
    const windows = callWindows(text, ROW_WRITE);
    expect(windows[0]).toMatch(/update: row\.changes,/);
    expect(windows[1]).toMatch(/data: row\.changes,/);
    const from = text.slice(text.indexOf("export interface DriveRowChanges {"));
    const changes = from.slice(0, from.indexOf("\n}"));
    expect(changes).toMatch(/readonly name: string;/);
    expect(changes).not.toMatch(/\b(userId|provider|sourceKey|sourceAccountId|externalId)\b/);
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

  it("only the user purge and the writer's two deletes delete rows", () => {
    expect(pathsWith(ROW_DELETE)).toEqual([ROWS_MODULE, "purge-user-data.ts"]);
    expect(fileAt("purge-user-data.ts")?.text).toContain("await tx.driveFile.deleteMany(scope);");
    const windows = callWindows(fileAt(ROWS_MODULE)?.text ?? "", ROW_DELETE);
    expect(windows).toHaveLength(2);
    // D3: one user's KLORN rows, by the ids D3 minted. Nothing of another source.
    expect(windows[0]).toMatch(
      /driveFile\.deleteMany\(\{\s*where: \{\s*userId,\s*provider: "KLORN",\s*sourceKey: KLORN_DRIVE_SOURCE_KEY,\s*externalId: \{ in: \[\.\.\.externalIds\] \},\s*\},/,
    );
    // D5b: every row of one connected account of one user, inside the unlink's
    // transaction. The provider is a ConnectedDriveProvider, so never KLORN.
    expect(windows[1]).toMatch(
      /^driveFile\.deleteMany\(\{\s*where: \{ userId, provider, sourceKey \},\s*\}\)/,
    );
    const text = fileAt(ROWS_MODULE)?.text ?? "";
    expect(text).toContain("await client.driveFile.deleteMany({");
    expect(text).toMatch(
      /export async function deleteLinkedAccountDriveRows\(\s*client: DriveRowsClient,\s*userId: string,\s*provider: ConnectedDriveProvider,\s*sourceKey: string,\s*\)/,
    );
  });

  it("only the account module's unlink deletes a connected account's rows", () => {
    const callers = files
      .filter((f) => /\bdeleteLinkedAccountDriveRows\(/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(callers).toEqual([ROWS_MODULE, ACCOUNTS_MODULE]);
    const text = fileAt(ACCOUNTS_MODULE)?.text ?? "";
    const unlink = text.slice(text.indexOf("export async function unlinkDriveAccount("));
    // Inside one transaction: the ownership check, the rows, then the account.
    const owned = unlink.indexOf("await tx.linkedDriveAccount.findFirst(");
    const rows = unlink.indexOf(
      "await deleteLinkedAccountDriveRows(tx, userId, provider, account.id)",
    );
    const gone = unlink.indexOf("await tx.linkedDriveAccount.deleteMany(");
    expect(unlink.indexOf("prisma.$transaction(")).toBeGreaterThan(-1);
    expect(owned).toBeGreaterThan(-1);
    expect(rows).toBeGreaterThan(owned);
    expect(gone).toBeGreaterThan(rows);
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

describe("the linked drive accounts (D5a, D5b): one module, the purge and the key sweep", () => {
  const ACCOUNT_CALL =
    /\blinkedDriveAccount\s*\.\s*(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|count|aggregate|groupBy|create|createMany|createManyAndReturn|upsert|update|updateMany|delete|deleteMany)\s*\(/g;

  it("only the account module, the user purge and the key-rotation sweep touch the table", () => {
    // D5b: drive/linked-drive-accounts.ts is the one module the connector uses.
    expect(pathsWith(ACCOUNT_CALL)).toEqual([
      ACCOUNTS_MODULE,
      "purge-user-data.ts",
      "scripts/reencrypt-tokens.ts",
    ]);
    expect(fileAt("purge-user-data.ts")?.text).toContain(
      "await tx.linkedDriveAccount.deleteMany(scope);",
    );
  });

  it("every query of the account module names the user", () => {
    const text = fileAt(ACCOUNTS_MODULE)?.text ?? "";
    const windows = callWindows(text, ACCOUNT_CALL);
    expect(windows.length).toBeGreaterThanOrEqual(7);
    for (const window of windows) {
      expect(window.slice(0, 160)).toMatch(
        /where: \{ (userId_provider_email: \{ userId, provider, email|id: accountId, userId|id, userId|userId,? )/,
      );
    }
  });

  it("the module encrypts every token it writes and refuses an empty one", () => {
    const text = fileAt(ACCOUNTS_MODULE)?.text ?? "";
    // encryptToken("") answers "", which the NOT NULL columns would store as a token.
    expect(text).toMatch(/if \(!grant\.accessToken \|\| !grant\.refreshToken\) \{/);
    // Every value the module gives a token column (not a type, not a select).
    const values = [
      ...text.matchAll(/(?<!readonly )\b(accessToken|refreshToken): (?!true\b)(\S+)/g),
    ].map((match) => match[2]);
    expect(values.length).toBeGreaterThanOrEqual(4);
    for (const value of values) expect(value).toMatch(/^encryptToken\(/);
  });

  it("the listing selects no token: id, email, needsReconnect, createdAt", () => {
    const text = fileAt(ACCOUNTS_MODULE)?.text ?? "";
    expect(text).toMatch(
      /const DRIVE_ACCOUNT_SUMMARY_SELECT = \{\s*id: true,\s*email: true,\s*needsReconnect: true,\s*createdAt: true,?\s*\} as const;/,
    );
    expect(text).toMatch(/select: DRIVE_ACCOUNT_SUMMARY_SELECT,/);
    expect(text.match(/\baccessToken: true\b/g)).toHaveLength(1);
    expect(text).toMatch(/const DRIVE_ACCOUNT_CREDENTIALS_SELECT = \{[^}]*accessToken: true/);
  });

  it("no source file names the table in a raw statement", () => {
    const raw = files
      .filter((f) => /\$(queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe)\b/.test(f.text))
      .filter((f) => /\bLinkedDriveAccount\b/.test(f.text))
      .map((f) => f.path);
    expect(raw).toEqual([]);
  });

  // A row holds an OAuth token pair, so a relation read is as much a leak as a
  // direct query: `include: { linkedDriveAccounts: true }` on a user, or
  // `include: { sourceAccount: true }` / `select: { sourceAccount: ... }` on a
  // drive file, returns the tokens. Code only: a comment may name the table.
  const ACCOUNT_NAME = /\b(linkedDriveAccounts?|LinkedDriveAccount)\b/;
  const FILE_TO_ACCOUNT = /\bsourceAccount\b/;
  const codeOf = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("only the account module, the purge and the sweep name the account table or its relations in code, so no include or select reaches the tokens", () => {
    const naming = files.filter((f) => ACCOUNT_NAME.test(codeOf(f.text))).map((f) => f.path);
    expect(naming.sort()).toEqual([
      ACCOUNTS_MODULE,
      "purge-user-data.ts",
      "scripts/reencrypt-tokens.ts",
    ]);
    const relation = files.filter((f) => FILE_TO_ACCOUNT.test(codeOf(f.text))).map((f) => f.path);
    expect(relation).toEqual([]);
  });

  it("the detector sees every relation read and ignores the column and comments (so the list cannot pass by scanning nothing)", () => {
    const seen = (text: string) =>
      ACCOUNT_NAME.test(codeOf(text)) || FILE_TO_ACCOUNT.test(codeOf(text));
    expect(
      seen("prisma.user.findUnique({ where: { id }, include: { linkedDriveAccounts: true } })"),
    ).toBe(true);
    expect(seen("select: { linkedDriveAccounts: { select: { accessToken: true } } }")).toBe(true);
    expect(seen("prisma.driveFile.findMany({ include: { sourceAccount: true } })")).toBe(true);
    expect(seen("select: { sourceAccount: { select: { refreshToken: true } } }")).toBe(true);
    expect(seen('import type { LinkedDriveAccount } from "@prisma/client";')).toBe(true);
    expect(seen("tx.linkedDriveAccount.findFirst({ where: { id } })")).toBe(true);
    expect(seen("const a = { sourceAccountId: row.sourceKey };")).toBe(false);
    expect(
      seen("// the cascade from LinkedDriveAccount\n/** sourceAccount: see the schema */"),
    ).toBe(false);
    expect(seen('const url = "https://x.test"; tx.linkedDriveAccount.count()')).toBe(true);
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
          /\.\.\.filtersOf\(options\)|\.\.\.klornRowsOf\(userId\)|\.\.\.accountRowsOf\(userId, account\)|where: \{ userId \}/,
        );
      }
    }
    expect(fileAt(READ_MODULE)?.text).toContain("[{ userId: options.userId, trashed: false }]");
    // D5c: one connected account's rows (its cap), trashed ones included.
    expect(fileAt(READ_MODULE)?.text).toContain(
      "return [{ userId, provider: account.provider, sourceKey: account.sourceKey }];",
    );
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
    // D5b: DRIVE_ENABLED and GOOGLE_DRIVE_ENABLED, read per request.
    expect(index).toMatch(
      /app\.register\(googleDriveLinkRoutes\(\{ gate: googleDriveRoutesEnabled \}\), \{\s*prefix: "\/api\/drive\/google",?\s*\}\)/,
    );
    for (const path of [
      "routes/drive.ts",
      "routes/klorn-drive.ts",
      "routes/google-drive-link.ts",
    ]) {
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
  const SYSTEM_QUERIES = ["dueSummaryUsers", "pruneSummaryUsage"];
  // How a store query names its user: inline, or through a helper pinned below.
  const NAMES_USER =
    /where: (\{\s*(driveFileId, userId|userId_dayKey: \{ userId, dayKey\b|userId,|\.\.\.ref,|id: row\.id,\s*userId|id: lease\.row\.id,\s*userId: lease\.row\.userId)|leased\(lease\)|unchanged\b)/;

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
    let scoped = 0;
    for (const match of store.matchAll(SUMMARY_CALL)) {
      const before = store.slice(0, match.index ?? 0);
      const name = [...before.matchAll(/function (\w+)\(/g)].at(-1)?.[1] ?? "";
      if (SYSTEM_QUERIES.includes(name)) continue;
      const window = store.slice(match.index ?? 0, (match.index ?? 0) + 220);
      if (name === "upsertQueued") {
        // The unique key only, so Postgres runs one INSERT ... ON CONFLICT; the
        // caller then refuses another user's row before anything else.
        expect(window).toMatch(/where: \{ driveFileId \},/);
        continue;
      }
      expect(window, name).toMatch(NAMES_USER);
      scoped += 1;
    }
    expect(scoped).toBeGreaterThanOrEqual(12);
    expect(store).toContain(
      'if (row.userId !== userId) throw new Error("drive summary: the file is another user\'s");',
    );
    expect(store).toMatch(
      /function leased\([^)]*\)[^{]*\{\s*return \{\s*id: lease\.row\.id,\s*userId: lease\.row\.userId,/,
    );
    expect(store).toMatch(/const unchanged = \{\s*id: row\.id,\s*userId: row\.userId,/);
    expect(store).toMatch(/const ref = \{ id: lease\.row\.id, userId: lease\.row\.userId \};/);
    for (const name of SYSTEM_QUERIES) {
      expect(store).toMatch(
        new RegExp(`/\\*\\* system: [^*]*\\*/\\nexport async function ${name}\\(`),
      );
    }
    expect(fileAt(EXPORT_MODULE)?.text).toMatch(
      /driveFileSummary\.findMany\(\{\s*where: \{ userId \}/,
    );
  });

  it("the summary search is the name search's escaped pattern, inside the same query", () => {
    const read = fileAt(READ_MODULE)?.text ?? "";
    expect(read).toContain(
      'const like = { contains: escapeLikePattern(text), mode: "insensitive" } as const;',
    );
    expect(read).toContain('{ summary: { is: { status: "DONE", summary: like } } }');
    expect(read.match(/\bcontains:/g)).toHaveLength(1);
    expect(fileAt(SUMMARY_STORE_MODULE)?.text).not.toMatch(/\bcontains:/);
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
    // D5c: the Picker's session and the index of picked files.
    "drive/google-drive-picker.ts",
    // D5b: the account table, the Google grant and the connector's connect.
    "drive/linked-drive-accounts.ts",
    "drive/providers/dispatch.ts",
    "drive/providers/google-auth.ts",
    // D5c: what is read of a Google file, and how it maps.
    "drive/providers/google-files.ts",
    "drive/providers/google.ts",
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
    // Reads only whether any drive source is on (user.files on /me, P12), and
    // hands a drive link's callback to the grant module (D5b); no rows.
    "routes/auth.ts",
    "routes/drive.ts",
    "routes/google-drive-link.ts",
    "routes/klorn-drive.ts",
    // Finishes a parked drive link for the session that started it (#1451).
    "routes/link-complete.ts",
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

  // routes/auth.ts is exempt only because it reads whether a drive source is on
  // (user.files, P12) and parks a drive link's code (D5b, #1451). A
  // module-level exemption must not cover rows: it may not touch the table, and
  // may import from the drive only the source switch and the state marker.
  it("routes/auth.ts reads only the drive's source switch and the link marker, never its rows", () => {
    const text = fileAt("routes/auth.ts")?.text ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(
      /\bdriveFile\b|prisma\.drive|DriveFile|linkedDriveAccount|completeGoogleDriveLink/,
    );
    const driveImports = [...text.matchAll(/from\s*["']([^"']*\/drive\/[^"']+)["']/g)].map(
      (match) => match[1],
    );
    expect(driveImports).toEqual(["../drive/drive-scope.js", "../drive/providers/google-auth.js"]);
    expect(text).toMatch(
      /import \{ googleDriveRoutesEnabled, visibleDriveProviders \} from "\.\.\/drive\/drive-scope\.js";/,
    );
    expect(text).toMatch(
      /import \{ DRIVE_LINK_STATE_MARKER \} from "\.\.\/drive\/providers\/google-auth\.js";/,
    );
  });

  // D5b on #1451: the callback parks a drive code (only while the drive is on)
  // and never exchanges it; POST /api/auth/link/complete finishes it.
  it("the callback's drive branch parks or refuses, before the callback's own exchange", () => {
    const text = fileAt("routes/auth.ts")?.text ?? "";
    const callback = text.slice(text.indexOf('"/google/callback",'));
    const stateChecked = callback.indexOf("statePayload = verifyToken(state);");
    const branch = callback.indexOf("if (statePayload.email === DRIVE_LINK_STATE_MARKER) {");
    const exchange = callback.indexOf("const { tokens } = await oauth2.getToken(code);");
    expect(stateChecked).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(stateChecked);
    expect(exchange).toBeGreaterThan(branch);
    const body = callback.slice(branch, callback.indexOf("\n      }\n", branch));
    expect(body).toMatch(
      /if \(!googleDriveRoutesEnabled\(\)\) \{\s*return reply\.redirect\(`\$\{webUrl\}\$\{LINK_FLOW_PATHS\[DRIVE_LINK_STATE_MARKER\]\.failed\}`\);\s*\}\s*return handOffAccountLink\(reply, \{/,
    );
    expect(body).not.toMatch(/getToken|completeGoogleDriveLink/);
  });

  it("only the authenticated link completion finishes a drive link", () => {
    const callers = files
      .filter((f) => /\bcompleteGoogleDriveLink\(/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(callers).toEqual(["drive/providers/google-auth.ts", "routes/link-complete.ts"]);
    expect(fileAt("routes/link-complete.ts")?.text).toMatch(
      /__link_drive__: \{[\s\S]*?finish: async \(userId, code\) => \(\{\s*next: driveLinkPath\(await completeGoogleDriveLink\(\{ code, userId \}\)\),/,
    );
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
      "./routes/google-drive-link.js",
      "./routes/klorn-drive.js",
    ]);
    expect(text.match(/\bexportDriveFiles\(/g)).toHaveLength(1);
    expect(text.match(/\bdriveRoutes\(/g)).toHaveLength(1);
    expect(text.match(/\bklornDriveRoutes\(/g)).toHaveLength(1);
    expect(text.match(/\bgoogleDriveLinkRoutes\(/g)).toHaveLength(1);
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
