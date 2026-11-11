/**
 * Migration 20261101120000_sent_history_import_marker: the completion marker
 * of the Sent-history import (mail/sent-history-import.ts). Its text is pinned
 * here: it waits at most 5 s for a lock (UserToken is on every request's
 * path), adds two nullable columns and nothing else.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, "..", "..", "prisma");
const MIGRATION = "20261101120000_sent_history_import_marker";
const sql = readFileSync(join(prismaDir, "migrations", MIGRATION, "migration.sql"), "utf8");
const statements = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.replace(/\s+/g, " ").trim())
  .filter(Boolean);
const schema = readFileSync(join(prismaDir, "schema.prisma"), "utf8");

describe("sent history import marker migration", () => {
  it("bounds its lock wait first, then adds exactly two nullable columns", () => {
    expect(statements).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      `ALTER TABLE "UserToken" ADD COLUMN "sentHistoryImportedAt" TIMESTAMP(3)`,
      `ALTER TABLE "LinkedInboxAccount" ADD COLUMN "sentHistoryImportedAt" TIMESTAMP(3)`,
    ]);
  });

  it("matches schema.prisma: an optional DateTime on both grant models", () => {
    for (const model of ["UserToken", "LinkedInboxAccount"]) {
      const body = schema.match(new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, "m"))?.[1] ?? "";
      expect(body).toMatch(/^\s+sentHistoryImportedAt\s+DateTime\?\s*$/m);
    }
  });
});
