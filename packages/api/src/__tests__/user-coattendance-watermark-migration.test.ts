/**
 * The co-attendance watermark, User.coAttendanceCountedThrough, in a migration of
 * its own: "User" is read by every request, so the one statement that locks it
 * runs alone, with a short lock_timeout, and stays metadata-only (nullable, no
 * default, no rewrite). Its text is pinned.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, "..", "..", "prisma");
const migrationsDir = join(prismaDir, "migrations");
const MIGRATION = "20261103020000_user_coattendance_watermark";
/** The co-attendance tables come first. */
const AFTER = "20261103010000_calendar_coattendance";

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

describe("user co-attendance watermark migration", () => {
  it("sorts right after the co-attendance tables", () => {
    const names = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf(AFTER) + 1);
  });

  it("adds one nullable column with no default, under a 2-second lock timeout, and nothing else", () => {
    expect(statements).toEqual([
      `SET LOCAL lock_timeout = '2s'`,
      `ALTER TABLE "User" ADD COLUMN "coAttendanceCountedThrough" TIMESTAMP(3)`,
    ]);
  });

  it("matches the schema: a nullable DateTime on User", () => {
    const user = schema.slice(schema.indexOf("model User {"));
    expect(user.slice(0, user.indexOf("\n}"))).toMatch(
      /\n\s+coAttendanceCountedThrough\s+DateTime\?/,
    );
  });
});
