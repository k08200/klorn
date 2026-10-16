/**
 * D5a: the Google Drive connector's schema step. One new table,
 * LinkedDriveAccount (a drive account linked for its files, D5 and D6), and one
 * new column, DriveFile.sourceAccountId, a foreign key to it. The SQL is the
 * contract for production, so its text is pinned; the CHECKs and the policies
 * are invisible to Prisma and the CI drift check.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findGaps, parseModels } from "./helpers/rls-coverage.js";

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, "..", "..", "prisma");
const migrationsDir = join(prismaDir, "migrations");
const MIGRATION = "20261015020000_linked_drive_account";
/** The latest migration on main when this one was written. */
const AFTER = "20261015010000_auto_unsubscribe_caps";

const sql = readFileSync(join(migrationsDir, MIGRATION, "migration.sql"), "utf8");
const statements = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim()
  .split(/;\s*/)
  .filter((statement) => statement.length > 0);
const header = sql
  .split("\n")
  .filter((line) => line.trim().startsWith("--"))
  .map((line) => line.replace(/^\s*--\s?/, ""))
  .join(" ")
  .replace(/\s+/g, " ");
const schema = readFileSync(join(prismaDir, "schema.prisma"), "utf8");

function block(header: string): string {
  const from = schema.slice(schema.indexOf(header));
  return from.slice(0, from.indexOf("\n}"));
}

function columnsOf(model: string): string[] {
  return block(model)
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//") && !line.startsWith("@@"))
    .map((line) => line.split(/\s+/)[0] ?? "");
}

const TABLE = [
  `CREATE TABLE "LinkedDriveAccount" (`,
  `"id" TEXT NOT NULL,`,
  `"userId" TEXT NOT NULL,`,
  `"provider" "DriveProvider" NOT NULL,`,
  `"email" TEXT NOT NULL,`,
  `"accessToken" TEXT NOT NULL,`,
  `"refreshToken" TEXT NOT NULL,`,
  `"expiresAt" TIMESTAMP(3),`,
  `"grantedScopes" TEXT NOT NULL,`,
  `"needsReconnect" BOOLEAN NOT NULL DEFAULT false,`,
  `"lastRefreshedAt" TIMESTAMP(3),`,
  `"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,`,
  `"updatedAt" TIMESTAMP(3) NOT NULL,`,
  `CONSTRAINT "LinkedDriveAccount_pkey" PRIMARY KEY ("id"),`,
  `CONSTRAINT "LinkedDriveAccount_provider_not_klorn_check" CHECK ("provider" <> 'KLORN') )`,
].join(" ");

const RLS = [
  `ALTER TABLE "LinkedDriveAccount" ENABLE ROW LEVEL SECURITY`,
  `CREATE POLICY "LinkedDriveAccount_tenant_isolation" ON "LinkedDriveAccount" USING ("userId" = current_setting('app.current_user_id', true))`,
  `CREATE POLICY "LinkedDriveAccount_system_bypass" ON "LinkedDriveAccount" USING (current_setting('app.bypass_rls', true) = 'on')`,
];

const PROVIDER_CHECK = `ALTER TABLE "DriveFile" ADD CONSTRAINT "DriveFile_sourceAccountId_klorn_check" CHECK (("provider" = 'KLORN') = ("sourceAccountId" IS NULL))`;
const SOURCE_KEY_CHECK = `ALTER TABLE "DriveFile" ADD CONSTRAINT "DriveFile_sourceAccountId_sourceKey_check" CHECK ("sourceAccountId" IS NULL OR "sourceAccountId" = "sourceKey")`;

describe("linked drive account migration", () => {
  it("is exactly these statements, in this order", () => {
    expect(statements).toEqual([
      `SET LOCAL lock_timeout = '5s'`,
      TABLE,
      `ALTER TABLE "DriveFile" ADD COLUMN "sourceAccountId" TEXT`,
      `CREATE UNIQUE INDEX "LinkedDriveAccount_userId_provider_email_key" ON "LinkedDriveAccount"("userId", "provider", "email")`,
      `CREATE INDEX "DriveFile_sourceAccountId_idx" ON "DriveFile"("sourceAccountId")`,
      `ALTER TABLE "LinkedDriveAccount" ADD CONSTRAINT "LinkedDriveAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
      `ALTER TABLE "DriveFile" ADD CONSTRAINT "DriveFile_sourceAccountId_fkey" FOREIGN KEY ("sourceAccountId") REFERENCES "LinkedDriveAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
      PROVIDER_CHECK,
      SOURCE_KEY_CHECK,
      ...RLS,
    ]);
  });

  it("fails fast behind a held lock: lock_timeout is the first statement", () => {
    expect(statements[0]).toBe(`SET LOCAL lock_timeout = '5s'`);
  });

  it("creates the sourceAccountId index before the foreign key whose cascade uses it", () => {
    const index = statements.findIndex((s) => s.includes(`"DriveFile_sourceAccountId_idx"`));
    const fk = statements.findIndex((s) => s.includes(`"DriveFile_sourceAccountId_fkey"`));
    expect(index).toBeGreaterThan(0);
    expect(fk).toBeGreaterThan(index);
  });

  it("row-level security has the form every per-user table uses: ENABLE, never FORCE, two policies", () => {
    const precedent = readFileSync(
      join(migrationsDir, "20260806033517_add_user_identity", "migration.sql"),
      "utf8",
    );
    const rls = (text: string, table: string) =>
      text
        .split("\n")
        .filter(
          (line) =>
            /ROW LEVEL SECURITY|CREATE POLICY/.test(line) &&
            !line.startsWith("--") &&
            line.includes(`"${table}"`),
        )
        .map((line) => line.trim().replaceAll(table, "<Table>"));
    expect(rls(sql, "LinkedDriveAccount")).toEqual(rls(precedent, "UserIdentity"));
    expect(rls(sql, "LinkedDriveAccount")).toHaveLength(3);
    expect(statements.join(" ")).not.toMatch(/FORCE ROW LEVEL SECURITY/);
  });

  it("sorts after the latest migration on main when it was written, with a timestamp of its own", () => {
    const names = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names.indexOf(AFTER)).toBeGreaterThanOrEqual(0);
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(names.indexOf(AFTER));
    expect(names.filter((name) => name.slice(0, 14) === MIGRATION.slice(0, 14))).toEqual([
      MIGRATION,
    ]);
  });

  it("is additive only: one table, one nullable column, no backfill, nothing dropped", () => {
    const body = statements.join(" ").replaceAll(/ON (DELETE|UPDATE) CASCADE/g, "");
    expect(body).not.toMatch(/\b(DROP|RENAME|TRUNCATE|DELETE|UPDATE|INSERT|ALTER COLUMN)\b/i);
    const TARGET =
      /^(?:ALTER TABLE|CREATE TABLE) "([^"]+)"|^CREATE (?:UNIQUE )?INDEX "[^"]+" ON "([^"]+)"|^CREATE POLICY "[^"]+" ON "([^"]+)"/;
    const targets = statements.slice(1).map((s) => {
      const match = s.match(TARGET);
      return match?.[1] ?? match?.[2] ?? match?.[3] ?? s;
    });
    expect([...new Set(targets)].sort()).toEqual(["DriveFile", "LinkedDriveAccount"]);
    const driveFileChanges = statements.filter((s) => s.startsWith(`ALTER TABLE "DriveFile"`));
    expect(driveFileChanges).toEqual([
      `ALTER TABLE "DriveFile" ADD COLUMN "sourceAccountId" TEXT`,
      `ALTER TABLE "DriveFile" ADD CONSTRAINT "DriveFile_sourceAccountId_fkey" FOREIGN KEY ("sourceAccountId") REFERENCES "LinkedDriveAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
      PROVIDER_CHECK,
      SOURCE_KEY_CHECK,
    ]);
  });

  it("records the preflight: the CHECKs hold on existing rows only while no non-KLORN DriveFile row exists", () => {
    expect(header).toContain(`SELECT count(*) FROM "DriveFile" WHERE "provider" <> 'KLORN'`);
    expect(header).toMatch(/klornDriveSource/);
    expect(header).toContain("P3009");
    expect(header).toContain(`prisma migrate resolve --rolled-back ${MIGRATION}`);
    expect(header).toMatch(/ACCESS EXCLUSIVE on "DriveFile"/);
    expect(header).toMatch(/SHARE ROW EXCLUSIVE/);
  });
});

describe("linked drive account schema", () => {
  it("LinkedDriveAccount holds these columns, and no CalDAV, IMAP or watch state", () => {
    expect(columnsOf("model LinkedDriveAccount {")).toEqual([
      "id",
      "userId",
      "user",
      "provider",
      "email",
      "accessToken",
      "refreshToken",
      "expiresAt",
      "grantedScopes",
      "needsReconnect",
      "lastRefreshedAt",
      "createdAt",
      "updatedAt",
      "files",
    ]);
  });

  it("the provider is a DriveProvider with no default, and the account goes with its user", () => {
    const model = block("model LinkedDriveAccount {");
    expect(model).toMatch(/\n\s+provider\s+DriveProvider\n/);
    expect(model).toMatch(
      /\n\s+user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)\n/,
    );
    expect(model).toMatch(/\n\s+accessToken\s+String\n/);
    expect(model).toMatch(/\n\s+refreshToken\s+String\n/);
    expect(model).toMatch(/\n\s+needsReconnect\s+Boolean\s+@default\(false\)\n/);
    expect(model).toContain("@@unique([userId, provider, email])");
    expect(model).toMatch(/\n\s+files\s+DriveFile\[\]\n/);
    expect(block("model User {")).toMatch(/\n\s+linkedDriveAccounts\s+LinkedDriveAccount\[\]\n/);
  });

  it("DriveFile.sourceAccountId is a nullable foreign key that cascades, with an index of its own", () => {
    const model = block("model DriveFile {");
    expect(model).toMatch(/\n\s+sourceAccountId\s+String\?\n/);
    expect(model).toMatch(
      /\n\s+sourceAccount\s+LinkedDriveAccount\?\s+@relation\(fields: \[sourceAccountId\], references: \[id\], onDelete: Cascade\)\n/,
    );
    expect(model).toContain("@@index([sourceAccountId])");
  });
});

describe("the RLS coverage guard sees this table", () => {
  const allMigrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => readFileSync(join(migrationsDir, name, "migration.sql"), "utf8"))
    .join("\n");
  const models = parseModels(schema);

  it("finds no gap with the migration as written", () => {
    expect(findGaps(allMigrations, models).map((gap) => gap.table)).toEqual([]);
  });

  it.each(RLS)("fails when this statement is removed: %s", (statement) => {
    const removed = allMigrations.replace(`${statement};`, "");
    expect(removed).not.toBe(allMigrations);
    expect(findGaps(removed, models).map((gap) => gap.table)).toEqual(["LinkedDriveAccount"]);
  });
});
