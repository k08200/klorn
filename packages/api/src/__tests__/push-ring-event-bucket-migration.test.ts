/**
 * PushRingEvent.bucket splits the per-user push rate limit into an interrupt
 * and an ambient bucket. Every push writes this table, and start.sh migrates
 * while the previous instance still serves, so the one statement that locks it
 * stays metadata-only (a constant default, no rewrite) under a lock timeout.
 * Rows the previous instance writes during the swap land in "ambient". Its
 * text is pinned.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, "..", "..", "prisma");
const migrationsDir = join(prismaDir, "migrations");
const MIGRATION = "20261107010000_push_ring_event_bucket";

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

describe("PushRingEvent bucket migration", () => {
  it("exists as a migration directory", () => {
    const names = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(names).toContain(MIGRATION);
  });

  it("adds one NOT NULL column with a constant 'ambient' default, under a lock timeout, and nothing else", () => {
    expect(statements).toEqual([
      `SET LOCAL lock_timeout = '5s'`,
      `ALTER TABLE "PushRingEvent" ADD COLUMN "bucket" TEXT NOT NULL DEFAULT 'ambient'`,
    ]);
  });

  it("matches the schema: a String defaulting to ambient on PushRingEvent", () => {
    const model = schema.slice(schema.indexOf("model PushRingEvent {"));
    expect(model.slice(0, model.indexOf("\n}"))).toMatch(
      /\n\s+bucket\s+String\s+@default\("ambient"\)/,
    );
  });
});
