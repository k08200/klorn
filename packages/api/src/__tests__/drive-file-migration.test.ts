/**
 * D2: the DriveFile table and the DriveProvider enum. The SQL is the contract for
 * production, so its text is pinned: one enum, one table, three indexes, one
 * foreign key, three CHECKs and the row-level-security policies, nothing that
 * touches an existing table. The CI Migrations job proves the table matches
 * schema.prisma; the CHECKs and the policies are invisible to Prisma, so they are
 * pinned here.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, "..", "..", "prisma");
const MIGRATION = "20261009010000_drive_file";
/** The latest migration on main when this one was written. */
const LATEST_WHEN_WRITTEN = "20261007010000_linked_calendar_display_name";

const sql = readFileSync(join(prismaDir, "migrations", MIGRATION, "migration.sql"), "utf8");
const statements = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim()
  .split(/;\s*/)
  .filter((statement) => statement.length > 0);
const schema = readFileSync(join(prismaDir, "schema.prisma"), "utf8");

function block(header: string): string {
  const from = schema.slice(schema.indexOf(header));
  return from.slice(0, from.indexOf("\n}"));
}

const TABLE = [
  `CREATE TABLE "DriveFile" (`,
  `"id" TEXT NOT NULL,`,
  `"userId" TEXT NOT NULL,`,
  `"provider" "DriveProvider" NOT NULL,`,
  `"sourceKey" TEXT NOT NULL,`,
  `"externalId" TEXT NOT NULL,`,
  `"name" TEXT NOT NULL,`,
  `"mimeType" TEXT,`,
  `"isFolder" BOOLEAN NOT NULL DEFAULT false,`,
  `"sizeBytes" BIGINT,`,
  `"parentExternalId" TEXT,`,
  `"modifiedAt" TIMESTAMP(3) NOT NULL,`,
  `"webUrl" TEXT,`,
  `"storageKey" TEXT,`,
  `"etag" TEXT,`,
  `"trashed" BOOLEAN NOT NULL DEFAULT false,`,
  `"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,`,
  `"updatedAt" TIMESTAMP(3) NOT NULL,`,
  `CONSTRAINT "DriveFile_pkey" PRIMARY KEY ("id"),`,
  `CONSTRAINT "DriveFile_webUrl_https_check" CHECK ("webUrl" IS NULL OR "webUrl" LIKE 'https://%'),`,
  `CONSTRAINT "DriveFile_storageKey_klorn_check" CHECK ("storageKey" IS NULL OR "provider" = 'KLORN'),`,
  `CONSTRAINT "DriveFile_sizeBytes_check" CHECK ("sizeBytes" IS NULL OR "sizeBytes" >= 0) )`,
].join(" ");

describe("DriveFile migration", () => {
  it("is exactly these statements, in this order", () => {
    expect(statements).toEqual([
      `SET LOCAL lock_timeout = '5s'`,
      `CREATE TYPE "DriveProvider" AS ENUM ('KLORN', 'GOOGLE', 'ONEDRIVE')`,
      TABLE,
      `CREATE INDEX "DriveFile_userId_modifiedAt_id_idx" ON "DriveFile"("userId", "modifiedAt", "id")`,
      `CREATE INDEX "DriveFile_userId_provider_modifiedAt_id_idx" ON "DriveFile"("userId", "provider", "modifiedAt", "id")`,
      `CREATE UNIQUE INDEX "DriveFile_userId_provider_sourceKey_externalId_key" ON "DriveFile"("userId", "provider", "sourceKey", "externalId")`,
      `ALTER TABLE "DriveFile" ADD CONSTRAINT "DriveFile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
      `ALTER TABLE "DriveFile" ENABLE ROW LEVEL SECURITY`,
      `CREATE POLICY "DriveFile_tenant_isolation" ON "DriveFile" USING ("userId" = current_setting('app.current_user_id', true))`,
      `CREATE POLICY "DriveFile_system_bypass" ON "DriveFile" USING (current_setting('app.bypass_rls', true) = 'on')`,
    ]);
  });

  it("row-level security has the form every per-user table uses: ENABLE, never FORCE, two policies", () => {
    const precedent = readFileSync(
      join(prismaDir, "migrations", "20260806033517_add_user_identity", "migration.sql"),
      "utf8",
    );
    const rls = (text: string, table: string) =>
      text
        .split("\n")
        .filter((line) => /ROW LEVEL SECURITY|CREATE POLICY/.test(line) && !line.startsWith("--"))
        .map((line) => line.trim().replaceAll(table, "<Table>"));
    expect(rls(sql, "DriveFile")).toEqual(rls(precedent, "UserIdentity"));
    expect(rls(sql, "DriveFile")).toHaveLength(3);
    expect(statements.join(" ")).not.toMatch(/FORCE ROW LEVEL SECURITY/);
  });

  it("touches no existing table: nothing is altered, dropped or backfilled", () => {
    const others = statements.filter(
      (statement) =>
        /\b(ALTER|DROP|UPDATE|DELETE|INSERT|POLICY)\b/.test(statement) &&
        !/"DriveFile"/.test(statement),
    );
    expect(others).toEqual([]);
    expect(statements.join(" ")).not.toMatch(/\bDROP\b/);
  });

  it("sorts after the latest migration that existed when it was written, with a timestamp of its own", () => {
    const names = readdirSync(join(prismaDir, "migrations"))
      .filter((name) => /^\d{14}_/.test(name))
      .sort();
    // After it, not directly after it: a migration that lands in between, or
    // later, is fine.
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(names.indexOf(LATEST_WHEN_WRITTEN));
    expect(names.indexOf(LATEST_WHEN_WRITTEN)).toBeGreaterThanOrEqual(0);
    expect(names.filter((name) => name.slice(0, 14) === MIGRATION.slice(0, 14))).toEqual([
      MIGRATION,
    ]);
  });

  it("the enum holds only the sources that have rows of their own", () => {
    const values = block("enum DriveProvider {")
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("//"));
    // No DEVICE: a device import (D7) lands in the Klorn drive as a KLORN row, and
    // Postgres cannot remove an enum value once it exists.
    expect(values).toEqual(["KLORN", "GOOGLE", "ONEDRIVE"]);
  });

  it("DriveFile is metadata only: these columns, no content, no summary state, no stored read-only flag", () => {
    const columns = block("model DriveFile {")
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("//") && !line.startsWith("@@"))
      .map((line) => line.split(/\s+/)[0]);
    expect(columns).toEqual([
      "id",
      "userId",
      "user",
      "provider",
      "sourceKey",
      "externalId",
      "name",
      "mimeType",
      "isFolder",
      "sizeBytes",
      "parentExternalId",
      "modifiedAt",
      "webUrl",
      "storageKey",
      "etag",
      "trashed",
      "createdAt",
      "updatedAt",
    ]);
  });

  it("provider and sourceKey have no default, so the compiler makes every writer state them", () => {
    const model = block("model DriveFile {");
    expect(model).toMatch(/\n\s+provider\s+DriveProvider\n/);
    expect(model).toMatch(/\n\s+sourceKey\s+String\n/);
  });

  it("rows go with their user: the relation cascades in the schema and in the SQL", () => {
    expect(block("model DriveFile {")).toMatch(
      /\n\s+user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)\n/,
    );
    expect(statements.filter((statement) => statement.includes("FOREIGN KEY"))).toEqual([
      `ALTER TABLE "DriveFile" ADD CONSTRAINT "DriveFile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    ]);
  });

  it("a row is unique per user, provider, source and upstream id, and both list orders have an index", () => {
    const model = block("model DriveFile {");
    expect(model).toContain(
      '@@unique([userId, provider, sourceKey, externalId], name: "driveFileIdentity")',
    );
    expect(model).toContain("@@index([userId, modifiedAt, id])");
    expect(model).toContain("@@index([userId, provider, modifiedAt, id])");
  });

  it("says nothing about a row-level-security backlog", () => {
    expect(sql).not.toMatch(/backlog/i);
  });
});
