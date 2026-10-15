/**
 * D4: the file summaries' schema step. Two new tables: DriveFileSummary (one
 * summary per drive file, its state, text and cost) and DriveSummaryUsage (the
 * per-user daily count). The SQL is the contract for production, so its text is
 * pinned; the CHECKs and the policies are invisible to Prisma and the CI drift
 * check.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, "..", "..", "prisma");
const MIGRATION = "20261014020000_drive_file_summary";
/** The migration whose DriveFile rows this one summarises (D3). */
const AFTER = "20261014010000_klorn_drive";

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

const SUMMARY_TABLE = [
  `CREATE TABLE "DriveFileSummary" (`,
  `"id" TEXT NOT NULL,`,
  `"driveFileId" TEXT NOT NULL,`,
  `"userId" TEXT NOT NULL,`,
  `"status" "DriveSummaryStatus" NOT NULL DEFAULT 'PENDING',`,
  `"summary" TEXT,`,
  `"sourceEtag" TEXT,`,
  `"model" TEXT,`,
  `"costMicroCents" INTEGER NOT NULL DEFAULT 0,`,
  `"error" TEXT,`,
  `"attempts" INTEGER NOT NULL DEFAULT 0,`,
  `"outageStreak" INTEGER NOT NULL DEFAULT 0,`,
  `"nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,`,
  `"runsDayKey" TEXT,`,
  `"runsToday" INTEGER NOT NULL DEFAULT 0,`,
  `"summarizedAt" TIMESTAMP(3),`,
  `"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,`,
  `"updatedAt" TIMESTAMP(3) NOT NULL,`,
  `CONSTRAINT "DriveFileSummary_pkey" PRIMARY KEY ("id"),`,
  `CONSTRAINT "DriveFileSummary_summary_check" CHECK ("summary" IS NULL OR char_length("summary") <= 1000),`,
  `CONSTRAINT "DriveFileSummary_error_check" CHECK ("error" IS NULL OR "error" ~ '^[a-z][a-z-]{0,63}$'),`,
  `CONSTRAINT "DriveFileSummary_counts_check" CHECK ("costMicroCents" >= 0 AND "attempts" >= 0 AND "outageStreak" >= 0 AND "runsToday" >= 0) )`,
].join(" ");

const USAGE_TABLE = [
  `CREATE TABLE "DriveSummaryUsage" (`,
  `"userId" TEXT NOT NULL,`,
  `"dayKey" TEXT NOT NULL,`,
  `"count" INTEGER NOT NULL DEFAULT 0,`,
  `"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,`,
  `"updatedAt" TIMESTAMP(3) NOT NULL,`,
  `CONSTRAINT "DriveSummaryUsage_pkey" PRIMARY KEY ("userId","dayKey"),`,
  `CONSTRAINT "DriveSummaryUsage_count_check" CHECK ("count" >= 0) )`,
].join(" ");

const rlsFor = (table: string) => [
  `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
  `CREATE POLICY "${table}_tenant_isolation" ON "${table}" USING ("userId" = current_setting('app.current_user_id', true))`,
  `CREATE POLICY "${table}_system_bypass" ON "${table}" USING (current_setting('app.bypass_rls', true) = 'on')`,
];

describe("drive file summary migration", () => {
  it("is exactly these statements, in this order", () => {
    expect(statements).toEqual([
      `SET LOCAL lock_timeout = '5s'`,
      `CREATE TYPE "DriveSummaryStatus" AS ENUM ('PENDING', 'DONE', 'FAILED', 'SKIPPED')`,
      SUMMARY_TABLE,
      USAGE_TABLE,
      `CREATE UNIQUE INDEX "DriveFileSummary_driveFileId_key" ON "DriveFileSummary"("driveFileId")`,
      `CREATE INDEX "DriveFileSummary_status_nextAttemptAt_idx" ON "DriveFileSummary"("status", "nextAttemptAt")`,
      `CREATE INDEX "DriveFileSummary_userId_status_summarizedAt_idx" ON "DriveFileSummary"("userId", "status", "summarizedAt")`,
      `CREATE INDEX "DriveSummaryUsage_dayKey_idx" ON "DriveSummaryUsage"("dayKey")`,
      `ALTER TABLE "DriveFileSummary" ADD CONSTRAINT "DriveFileSummary_driveFileId_fkey" FOREIGN KEY ("driveFileId") REFERENCES "DriveFile"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
      `ALTER TABLE "DriveFileSummary" ADD CONSTRAINT "DriveFileSummary_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
      `ALTER TABLE "DriveSummaryUsage" ADD CONSTRAINT "DriveSummaryUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
      ...rlsFor("DriveFileSummary"),
      ...rlsFor("DriveSummaryUsage"),
    ]);
  });

  it("row-level security has the form every per-user table uses: ENABLE, never FORCE, two policies each", () => {
    const precedent = readFileSync(
      join(prismaDir, "migrations", "20260806033517_add_user_identity", "migration.sql"),
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
    for (const table of ["DriveFileSummary", "DriveSummaryUsage"]) {
      expect(rls(sql, table)).toEqual(rls(precedent, "UserIdentity"));
      expect(rls(sql, table)).toHaveLength(3);
    }
    expect(statements.join(" ")).not.toMatch(/FORCE ROW LEVEL SECURITY/);
  });

  it("sorts after the Klorn drive migration and is additive only", () => {
    const names = readdirSync(join(prismaDir, "migrations"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(names.indexOf(AFTER));
    expect(names.indexOf(AFTER)).toBeGreaterThanOrEqual(0);
    const body = statements.join(" ").replaceAll(/ON (DELETE|UPDATE) CASCADE/g, "");
    expect(body).not.toMatch(/\b(DROP|RENAME|TRUNCATE|DELETE|UPDATE|ALTER COLUMN)\b/i);
  });

  it("the schema agrees: one summary per file, both rows go with their file and user", () => {
    const summary = block("model DriveFileSummary {");
    expect(summary).toMatch(/\n\s+driveFileId\s+String\s+@unique\n/);
    expect(summary).toMatch(
      /\n\s+driveFile\s+DriveFile\s+@relation\(fields: \[driveFileId\], references: \[id\], onDelete: Cascade\)\n/,
    );
    expect(summary).toMatch(
      /\n\s+user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)\n/,
    );
    expect(summary).toContain("@@index([status, nextAttemptAt])");
    expect(summary).toContain("@@index([userId, status, summarizedAt])");
    const usage = block("model DriveSummaryUsage {");
    expect(usage).toContain("@@id([userId, dayKey])");
    expect(usage).toMatch(
      /\n\s+user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)\n/,
    );
    expect(
      block("enum DriveSummaryStatus {")
        .split("\n")
        .slice(1)
        .map((l) => l.trim()),
    ).toEqual(["PENDING", "DONE", "FAILED", "SKIPPED"]);
  });

  it("stores no extracted file text: no column for it", () => {
    const columns = block("model DriveFileSummary {")
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("//") && !line.startsWith("@@"))
      .map((line) => line.split(/\s+/)[0]);
    expect(columns).not.toContain("text");
    expect(columns).not.toContain("contentText");
    expect(columns).not.toContain("storageKey");
  });
});
