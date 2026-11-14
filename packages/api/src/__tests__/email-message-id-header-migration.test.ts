/**
 * EmailMessage.messageIdHeader: the RFC 5322 Message-ID the IMAP poll stores so an
 * attachment of a message that left INBOX can still be found (attachment-bytes.ts).
 * EmailMessage is written by every sync and start.sh migrates while the previous
 * instance still serves, so the one statement stays metadata-only (a nullable
 * column, no default, no index, no backfill) under a lock timeout. Its text is pinned.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, "..", "..", "prisma");
const migrationsDir = join(prismaDir, "migrations");
const MIGRATION = "20261114140000_email_message_id_header";

const migrationNames = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const readStatements = () =>
  readFileSync(join(migrationsDir, MIGRATION, "migration.sql"), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/;\s*/)
    .filter((statement) => statement.length > 0);

describe("EmailMessage messageIdHeader migration", () => {
  it("exists as a migration directory, after the IMAP presets one", () => {
    expect(migrationNames).toContain(MIGRATION);
    expect(MIGRATION > "20261114130000_imap_preset_providers").toBe(true);
  });

  it("adds one nullable TEXT column under a lock timeout, and nothing else", () => {
    expect(readStatements()).toEqual([
      `SET LOCAL lock_timeout = '5s'`,
      `ALTER TABLE "EmailMessage" ADD COLUMN "messageIdHeader" TEXT`,
    ]);
  });

  it("matches the schema: an optional String on EmailMessage", () => {
    const schema = readFileSync(join(prismaDir, "schema.prisma"), "utf8");
    const model = schema.slice(schema.indexOf("model EmailMessage {"));
    expect(model.slice(0, model.indexOf("\n}"))).toMatch(/\n\s+messageIdHeader\s+String\?/);
  });
});
