/**
 * C6: LinkedCalendarAccount.displayName holds a device calendar's title (its
 * `email` holds `device:<key>`). The SQL is the contract for production rows, so
 * its text is pinned: one additive, nullable column, nothing else. The CI
 * Migrations job proves it matches schema.prisma.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, "..", "..", "prisma");
const MIGRATION = "20261007010000_linked_calendar_display_name";

const sql = readFileSync(join(prismaDir, "migrations", MIGRATION, "migration.sql"), "utf8");
const statements = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();
const schema = readFileSync(join(prismaDir, "schema.prisma"), "utf8");

describe("device calendar source migration", () => {
  it("only adds one nullable text column: no default, no backfill, nothing destructive", () => {
    expect(statements).toBe(
      `SET LOCAL lock_timeout = '5s'; ALTER TABLE "LinkedCalendarAccount" ADD COLUMN "displayName" TEXT;`,
    );
  });

  it("is slotted after the latest migration before it, with a timestamp of its own", () => {
    const names = readdirSync(join(prismaDir, "migrations"))
      .filter((n) => /^\d{14}_/.test(n))
      .sort();
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("20261006010000_proactive_draft") + 1);
    // Older migrations share timestamps; this one must not.
    expect(names.filter((n) => n.slice(0, 14) === MIGRATION.slice(0, 14))).toEqual([MIGRATION]);
  });

  it("the schema declares it optional on LinkedCalendarAccount, and DEVICE already exists", () => {
    const model = schema.slice(schema.indexOf("model LinkedCalendarAccount {"));
    expect(model.slice(0, model.indexOf("\n}"))).toMatch(/\n\s+displayName\s+String\?\n/);
    const providers = schema.slice(schema.indexOf("enum CalendarProvider {"));
    expect(providers.slice(0, providers.indexOf("}"))).toMatch(/\n\s+DEVICE\n/);
  });
});
