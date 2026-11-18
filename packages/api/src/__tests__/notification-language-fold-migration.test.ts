/**
 * The retired-language fold (2026-11-17): a stored ja/es/fr/de notification
 * language becomes "en", matching what Settings shows. Data only — it must
 * never touch a shipped value or change the schema. Its text is pinned.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "prisma", "migrations");
const MIGRATION = "20261118120000_notification_language_retired_fold";

const migrationNames = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const statements = () =>
  readFileSync(join(migrationsDir, MIGRATION, "migration.sql"), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/;\s*/)
    .filter((statement) => statement.length > 0);

describe("notification language retired-fold migration", () => {
  it("exists as a migration directory", () => {
    expect(migrationNames).toContain(MIGRATION);
  });

  it("rewrites exactly the four retired codes to en, under a lock timeout, and nothing else", () => {
    expect(statements()).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      `UPDATE "AutomationConfig" SET "notificationLanguage" = 'en' WHERE "notificationLanguage" IN ('ja', 'es', 'fr', 'de')`,
    ]);
  });
});
