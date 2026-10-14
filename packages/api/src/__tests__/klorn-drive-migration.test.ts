/**
 * D3: the Klorn drive's schema step. One new table, StoragePurge (the durable
 * record of an account's objects still to be deleted), and one new index on
 * DriveFile for folder browsing. The SQL is the contract for production, so its
 * text is pinned; the policies are invisible to Prisma and the CI drift check.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, "..", "..", "prisma");
const MIGRATION = "20261014010000_klorn_drive";
/** The latest migration on main when this one was written (#1381's second). */
const LATEST_WHEN_WRITTEN = "20261010030000_enable_rls_remaining_tables";

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
  `CREATE TABLE "StoragePurge" (`,
  `"userId" TEXT NOT NULL,`,
  `"requestedAt" TIMESTAMP(3) NOT NULL,`,
  `"attempts" INTEGER NOT NULL DEFAULT 0,`,
  `"lastError" TEXT,`,
  `"nextAttemptAt" TIMESTAMP(3) NOT NULL,`,
  `"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,`,
  `"updatedAt" TIMESTAMP(3) NOT NULL,`,
  `CONSTRAINT "StoragePurge_pkey" PRIMARY KEY ("userId"),`,
  `CONSTRAINT "StoragePurge_attempts_check" CHECK ("attempts" >= 0) )`,
].join(" ");

describe("Klorn drive migration", () => {
  it("is exactly these statements, in this order", () => {
    expect(statements).toEqual([
      `SET LOCAL lock_timeout = '5s'`,
      TABLE,
      `CREATE INDEX "StoragePurge_nextAttemptAt_idx" ON "StoragePurge"("nextAttemptAt")`,
      `CREATE INDEX "DriveFile_userId_provider_parentExternalId_modifiedAt_id_idx" ON "DriveFile"("userId", "provider", "parentExternalId", "modifiedAt", "id")`,
      `ALTER TABLE "StoragePurge" ENABLE ROW LEVEL SECURITY`,
      `CREATE POLICY "StoragePurge_tenant_isolation" ON "StoragePurge" USING ("userId" = current_setting('app.current_user_id', true))`,
      `CREATE POLICY "StoragePurge_system_bypass" ON "StoragePurge" USING (current_setting('app.bypass_rls', true) = 'on')`,
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
    expect(rls(sql, "StoragePurge")).toEqual(rls(precedent, "UserIdentity"));
    expect(rls(sql, "StoragePurge")).toHaveLength(3);
    expect(statements.join(" ")).not.toMatch(/FORCE ROW LEVEL SECURITY/);
  });

  it("a pending purge outlives its user: no foreign key, no relation, nothing cascades it away", () => {
    expect(statements.join(" ")).not.toMatch(/FOREIGN KEY/);
    expect(block("model StoragePurge {")).not.toMatch(/@relation|\bUser\b/);
  });

  it("is additive: one table, two indexes, nothing existing altered or dropped", () => {
    const touchingOthers = statements.filter(
      (statement) =>
        /\b(ALTER|DROP|UPDATE|DELETE|INSERT)\b/.test(statement) &&
        !/"StoragePurge"/.test(statement),
    );
    expect(touchingOthers).toEqual([]);
    expect(statements.join(" ")).not.toMatch(/\bDROP\b/);
  });

  it("the schema declares the folder index and the purge record", () => {
    expect(block("model DriveFile {")).toContain(
      "@@index([userId, provider, parentExternalId, modifiedAt, id])",
    );
    const columns = block("model StoragePurge {")
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("//") && !line.startsWith("@@"))
      .map((line) => line.split(/\s+/)[0]);
    expect(columns).toEqual([
      "userId",
      "requestedAt",
      "attempts",
      "lastError",
      "nextAttemptAt",
      "createdAt",
      "updatedAt",
    ]);
    expect(block("model StoragePurge {")).toContain("@@index([nextAttemptAt])");
  });

  it("sorts after the latest migration that existed when it was written, with a timestamp of its own", () => {
    const names = readdirSync(join(prismaDir, "migrations"))
      .filter((name) => /^\d{14}_/.test(name))
      .sort();
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(names.indexOf(LATEST_WHEN_WRITTEN));
    expect(names.indexOf(LATEST_WHEN_WRITTEN)).toBeGreaterThanOrEqual(0);
    expect(names.filter((name) => name.slice(0, 14) === MIGRATION.slice(0, 14))).toEqual([
      MIGRATION,
    ]);
  });
});
