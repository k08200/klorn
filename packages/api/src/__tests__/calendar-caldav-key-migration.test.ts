/**
 * C3 review fix (2026-10-02): CalendarEvent.caldavCalendarKey records which
 * calendar of a CalDAV account a row was listed from, so a calendar missing from
 * one discovery is not read as empty. The SQL is the contract for production
 * rows, so its text is pinned: one additive, nullable column, nothing else. The CI
 * Migrations job proves it matches schema.prisma.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, "..", "..", "prisma");
const MIGRATION = "20261005010000_calendar_caldav_calendar_key";

const sql = readFileSync(join(prismaDir, "migrations", MIGRATION, "migration.sql"), "utf8");
const statements = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();
const schema = readFileSync(join(prismaDir, "schema.prisma"), "utf8");

describe("caldavCalendarKey migration", () => {
  it("only adds one nullable text column: no default, no backfill, nothing destructive", () => {
    expect(statements).toBe(`ALTER TABLE "CalendarEvent" ADD COLUMN "caldavCalendarKey" TEXT;`);
  });

  it("the schema declares it optional on CalendarEvent", () => {
    const model = schema.slice(schema.indexOf("model CalendarEvent {"));
    expect(model.slice(0, model.indexOf("\n}"))).toMatch(/\n\s+caldavCalendarKey\s+String\?\n/);
  });
});
