/**
 * D2: the DriveFile table and the DriveProvider enum. The SQL is the contract for
 * production, so its text is pinned: one enum, one table, two indexes, one foreign
 * key and two CHECKs, nothing that touches an existing table. The CI Migrations job
 * proves the table matches schema.prisma; the CHECKs are invisible to Prisma, so
 * they are pinned here.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, "..", "..", "prisma");
const MIGRATION = "20261009010000_drive_file";
const PREVIOUS = "20261007010000_linked_calendar_display_name";

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

describe("DriveFile migration", () => {
  it("is exactly these statements, in this order", () => {
    expect(statements).toEqual([
      `SET LOCAL lock_timeout = '5s'`,
      `CREATE TYPE "DriveProvider" AS ENUM ('KLORN', 'GOOGLE', 'ONEDRIVE', 'DEVICE')`,
      `CREATE TABLE "DriveFile" ( "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "provider" "DriveProvider" NOT NULL, "sourceKey" TEXT NOT NULL, "externalId" TEXT NOT NULL, "name" TEXT NOT NULL, "mimeType" TEXT, "isFolder" BOOLEAN NOT NULL DEFAULT false, "sizeBytes" BIGINT, "parentExternalId" TEXT, "modifiedAt" TIMESTAMP(3) NOT NULL, "webUrl" TEXT, "storageKey" TEXT, "readOnly" BOOLEAN NOT NULL DEFAULT true, "trashed" BOOLEAN NOT NULL DEFAULT false, "summaryStatus" TEXT NOT NULL DEFAULT 'NONE', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "DriveFile_pkey" PRIMARY KEY ("id"), CONSTRAINT "DriveFile_webUrl_https_check" CHECK ("webUrl" IS NULL OR "webUrl" LIKE 'https://%'), CONSTRAINT "DriveFile_storageKey_klorn_held_check" CHECK ("storageKey" IS NULL OR "provider" IN ('KLORN', 'DEVICE')) )`,
      `CREATE INDEX "DriveFile_userId_modifiedAt_id_idx" ON "DriveFile"("userId", "modifiedAt", "id")`,
      `CREATE UNIQUE INDEX "DriveFile_userId_provider_sourceKey_externalId_key" ON "DriveFile"("userId", "provider", "sourceKey", "externalId")`,
      `ALTER TABLE "DriveFile" ADD CONSTRAINT "DriveFile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    ]);
  });

  it("touches no existing table: nothing is altered, dropped or backfilled", () => {
    const others = statements.filter(
      (statement) =>
        /\b(ALTER|DROP|UPDATE|DELETE|INSERT)\b/.test(statement) && !/"DriveFile"/.test(statement),
    );
    expect(others).toEqual([]);
    expect(statements.join(" ")).not.toMatch(/\bDROP\b/);
  });

  it("is slotted right after the migration that was the latest on main, with a timestamp of its own", () => {
    const names = readdirSync(join(prismaDir, "migrations"))
      .filter((name) => /^\d{14}_/.test(name))
      .sort();
    // Nothing may land between the two; a later migration is fine.
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf(PREVIOUS) + 1);
    expect(names.filter((name) => name.slice(0, 14) === MIGRATION.slice(0, 14))).toEqual([
      MIGRATION,
    ]);
  });

  it("the enum holds only the sources the plan names", () => {
    const values = block("enum DriveProvider {")
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("//"));
    expect(values).toEqual(["KLORN", "GOOGLE", "ONEDRIVE", "DEVICE"]);
  });

  it("DriveFile is metadata only: these columns and no content column", () => {
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
      "readOnly",
      "trashed",
      "summaryStatus",
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
    expect(statements.at(-1)).toContain('REFERENCES "User"("id") ON DELETE CASCADE');
  });

  it("a row is unique per user, provider, source and upstream id", () => {
    expect(block("model DriveFile {")).toContain(
      '@@unique([userId, provider, sourceKey, externalId], name: "driveFileIdentity")',
    );
  });
});
