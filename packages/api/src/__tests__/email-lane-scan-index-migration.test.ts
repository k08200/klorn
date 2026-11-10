/**
 * The lane-scan covering index on EmailMessage (recommended in #1483). The
 * migration SQL is the production contract, so its statement is pinned here.
 * Prisma 6 cannot express INCLUDE, so schema.prisma carries the shape its
 * describer reads back (INCLUDE columns as trailing key columns) to keep the CI
 * `migrate diff` drift check green; this test keeps the two in lockstep.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, "..", "..", "prisma");
const migrationsDir = join(prismaDir, "migrations");
const MIGRATION = "20261017020000_email_lane_scan_index";
/** The latest migration on main when this one was written. */
const AFTER = "20261017010000_device_push_data_messages";

const sql = readFileSync(join(migrationsDir, MIGRATION, "migration.sql"), "utf8");
const statements = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim()
  .split(/;\s*/)
  .filter((statement) => statement.length > 0);
const schema = readFileSync(join(prismaDir, "schema.prisma"), "utf8");

describe("migration 20261017020000_email_lane_scan_index", () => {
  it("is one plain CREATE INDEX with the covering shape", () => {
    expect(statements).toEqual([
      `CREATE INDEX IF NOT EXISTS "EmailMessage_lane_scan_idx" ON "EmailMessage" ("userId", "receivedAt" DESC, "id" DESC) INCLUDE ("linkedInboxAccountId", "threadId", "isRead")`,
    ]);
  });

  it("does not use CONCURRENTLY (Prisma runs migrations in a transaction)", () => {
    expect(statements.join(" ")).not.toMatch(/CONCURRENTLY/i);
  });

  it("sorts after the latest migration it was written against", () => {
    const names = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names.indexOf(AFTER)).toBeGreaterThanOrEqual(0);
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(names.indexOf(AFTER));
  });

  it("is mirrored in schema.prisma as the shape migrate diff reads back", () => {
    expect(schema).toContain(
      `@@index([userId, receivedAt(sort: Desc), id(sort: Desc), linkedInboxAccountId, threadId, isRead], map: "EmailMessage_lane_scan_idx")`,
    );
  });
});
