/**
 * C2 migration (docs/providers/unified-platform-plan.md): the dedupe decision
 * for linked-calendar rows. The SQL is the contract for what production rows
 * may look like, so its text is pinned here. The CI Migrations job proves the
 * SQL matches schema.prisma; this proves it says what the plan decided, and
 * that the previous release (C1) keeps every conflict target it writes against.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, "..", "..", "prisma");
const MIGRATION = "20261002010000_calendar_linked_source_key";

const sql = readFileSync(join(prismaDir, "migrations", MIGRATION, "migration.sql"), "utf8");
const schema = readFileSync(join(prismaDir, "schema.prisma"), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const code = flat(
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n"),
);
const header = flat(
  sql
    .split("\n")
    .filter((line) => line.trim().startsWith("--"))
    .map((line) => line.replace(/^\s*--\s?/, ""))
    .join(" "),
);

const NEW_UNIQUE = "CalendarEvent_userId_provider_sourceKey_externalId_key";
const C1_UNIQUE = "CalendarEvent_userId_provider_externalId_key";

describe("linked-calendar migration — the dedupe key", () => {
  it("fails fast when a lock is held: lock_timeout is the first statement", () => {
    expect(code.startsWith(`SET LOCAL lock_timeout = '5s';`)).toBe(true);
  });

  it("adds sourceKey as a NOT NULL column defaulting to 'primary' (so the previous release's inserts stay valid)", () => {
    expect(code).toContain(
      `ALTER TABLE "CalendarEvent" ADD COLUMN "sourceKey" TEXT NOT NULL DEFAULT 'primary';`,
    );
  });

  it("backfills sourceKey from sourceAccountId, a no-op today because no writer has set it", () => {
    expect(code).toContain(
      `UPDATE "CalendarEvent" SET "sourceKey" = "sourceAccountId" WHERE "sourceAccountId" IS NOT NULL;`,
    );
  });

  it("creates the (userId, provider, sourceKey, externalId) unique", () => {
    expect(code).toContain(
      `CREATE UNIQUE INDEX "${NEW_UNIQUE}" ON "CalendarEvent"("userId", "provider", "sourceKey", "externalId");`,
    );
  });

  it("builds the new unique BEFORE dropping C1's, so uniqueness is never unenforced", () => {
    const created = code.indexOf(`CREATE UNIQUE INDEX "${NEW_UNIQUE}"`);
    const dropped = code.indexOf(`DROP INDEX "${C1_UNIQUE}"`);
    expect(created).toBeGreaterThan(-1);
    expect(dropped).toBeGreaterThan(created);
  });

  it("drops C1's (userId, provider, externalId) unique: a linked row would otherwise block the previous release's primary insert", () => {
    expect(code).toContain(`DROP INDEX "${C1_UNIQUE}";`);
  });

  it("keeps the (userId, googleId) unique and the googleId column: the previous release's ON CONFLICT target", () => {
    expect(code).not.toContain("CalendarEvent_userId_googleId_key");
    expect(code).not.toMatch(/DROP COLUMN|"googleId" (DROP|TYPE|SET)/);
  });

  it("drops nothing else", () => {
    const drops = code.match(/DROP (TABLE|COLUMN|TYPE|INDEX|CONSTRAINT)[^;]*;/g) ?? [];
    expect(drops).toEqual([`DROP INDEX "${C1_UNIQUE}";`]);
    expect(code).not.toMatch(/TRUNCATE|DELETE FROM/);
  });

  it("keeps sourceKey consistent with sourceAccountId with a CHECK", () => {
    expect(code).toContain(
      `ADD CONSTRAINT "CalendarEvent_sourceKey_matches_sourceAccountId" CHECK ("sourceKey" = COALESCE("sourceAccountId", 'primary'));`,
    );
  });

  it("indexes sourceAccountId, which the cascade and the unlink delete both look rows up by", () => {
    expect(code).toContain(
      `CREATE INDEX "CalendarEvent_sourceAccountId_idx" ON "CalendarEvent"("sourceAccountId");`,
    );
  });

  it("makes sourceAccountId a foreign key with ON DELETE CASCADE, so unlinking cannot leave orphan rows", () => {
    expect(code).toContain(
      `ADD CONSTRAINT "CalendarEvent_sourceAccountId_fkey" FOREIGN KEY ("sourceAccountId") REFERENCES "LinkedCalendarAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
    );
  });

  it("creates the index before the foreign key that uses it", () => {
    expect(code.indexOf(`CREATE INDEX "CalendarEvent_sourceAccountId_idx"`)).toBeLessThan(
      code.indexOf(`CalendarEvent_sourceAccountId_fkey`),
    );
  });
});

describe("linked-calendar migration — the decision record", () => {
  it("says why C1's unique cannot stay and why the previous release is unaffected", () => {
    expect(header).toMatch(/previous release/i);
    expect(header).toMatch(/ON CONFLICT \("userId", "googleId"\)/);
    expect(header).toMatch(/ON CONFLICT \("userId", "provider", "email"\)/);
  });

  it("says why the alternatives were rejected", () => {
    expect(header).toMatch(/COALESCE.* expression unique index/i);
    expect(header).toMatch(/NULLS NOT DISTINCT/);
    expect(header).toMatch(/sentinel/i);
  });

  it("explains the cascade: the mid-flight sync and the previous release's unlink route", () => {
    expect(header).toMatch(/ON DELETE CASCADE/);
    expect(header).toMatch(/mid-flight/);
    expect(header).toMatch(/rollback/);
  });

  it("records what the contract phase drops", () => {
    expect(header).toMatch(/Contract phase/);
    expect(header).toContain(`"sourceKey" DEFAULT`);
    expect(header).toContain(`"googleId"`);
  });
});

describe("linked-calendar migration — schema.prisma carries the same shape", () => {
  const event = schema.match(/model CalendarEvent \{[\s\S]*?\n\}/)?.[0] ?? "";

  it("declares sourceKey with the default and the new unique, without C1's unique", () => {
    expect(event).toMatch(/sourceKey\s+String\s+@default\("primary"\)/);
    expect(event).toContain("@@unique([userId, provider, sourceKey, externalId])");
    expect(event).not.toContain("@@unique([userId, provider, externalId])");
  });

  it("still declares the legacy (userId, googleId) unique, the sourceAccountId index and the cascade relation", () => {
    expect(event).toContain("@@unique([userId, googleId])");
    expect(event).toContain("@@index([sourceAccountId])");
    expect(event).toMatch(
      /sourceAccount\s+LinkedCalendarAccount\?\s+@relation\(fields: \[sourceAccountId\], references: \[id\], onDelete: Cascade\)/,
    );
  });
});
