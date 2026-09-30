/**
 * C1 migration (docs/providers/unified-platform-plan.md): the SQL is the
 * contract for what production rows become, so its text is pinned here. The
 * CI Migrations job proves the SQL matches schema.prisma; this proves it says
 * what the plan decided — additive, backfill rule, unique-key swap, nothing
 * destructive.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, "..", "..", "prisma");
const MIGRATION = "20260930010000_calendar_provider";

const sql = readFileSync(join(prismaDir, "migrations", MIGRATION, "migration.sql"), "utf8");
// Statements only — the header comment is allowed to talk about what it avoids.
const statements = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const schema = readFileSync(join(prismaDir, "schema.prisma"), "utf8");

/** Collapse whitespace so assertions do not depend on formatting. */
const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const code = flat(statements);

describe("calendar provider migration — enum", () => {
  it("creates CalendarProvider with exactly the sources the plan's C steps name", () => {
    expect(code).toContain(
      `CREATE TYPE "CalendarProvider" AS ENUM ('GOOGLE', 'OUTLOOK', 'ICLOUD', 'NAVER', 'DEVICE', 'LOCAL');`,
    );
  });

  it("schema.prisma declares the same six values in the same order", () => {
    const block = schema.match(/enum CalendarProvider \{([^}]*)\}/)?.[1] ?? "";
    const values = block
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .filter(Boolean);
    expect(values).toEqual(["GOOGLE", "OUTLOOK", "ICLOUD", "NAVER", "DEVICE", "LOCAL"]);
  });
});

describe("calendar provider migration — LinkedCalendarAccount", () => {
  it("adds provider (NOT NULL, default GOOGLE) and the two nullable non-OAuth credential columns", () => {
    expect(code).toContain(
      `ALTER TABLE "LinkedCalendarAccount" ADD COLUMN "provider" "CalendarProvider" NOT NULL DEFAULT 'GOOGLE', ADD COLUMN "caldavUrl" TEXT, ADD COLUMN "caldavPasswordCipher" TEXT, ALTER COLUMN "accessToken" DROP NOT NULL;`,
    );
  });

  it("swaps the unique key from (userId, email) to (userId, provider, email) without touching rows", () => {
    expect(code).toContain(`DROP INDEX "LinkedCalendarAccount_userId_email_key";`);
    expect(code).toContain(
      `CREATE UNIQUE INDEX "LinkedCalendarAccount_userId_provider_email_key" ON "LinkedCalendarAccount"("userId", "provider", "email");`,
    );
    expect(code).not.toMatch(/DELETE FROM "LinkedCalendarAccount"|UPDATE "LinkedCalendarAccount"/);
  });
});

describe("calendar provider migration — CalendarEvent", () => {
  it("adds provider (NOT NULL, default GOOGLE), externalId and sourceAccountId as plain columns", () => {
    expect(code).toContain(
      `ALTER TABLE "CalendarEvent" ADD COLUMN "provider" "CalendarProvider" NOT NULL DEFAULT 'GOOGLE', ADD COLUMN "externalId" TEXT, ADD COLUMN "sourceAccountId" TEXT;`,
    );
  });

  it("gives sourceAccountId no foreign key (same as EmailMessage.linkedInboxAccountId)", () => {
    expect(code).not.toMatch(/FOREIGN KEY|REFERENCES/);
  });

  it("backfills in one pass: a googleId makes the row GOOGLE with externalId = googleId, none makes it LOCAL", () => {
    expect(code).toContain(
      `UPDATE "CalendarEvent" SET "provider" = CASE WHEN "googleId" IS NULL THEN 'LOCAL'::"CalendarProvider" ELSE 'GOOGLE'::"CalendarProvider" END, "externalId" = "googleId";`,
    );
  });

  it("backfills before the new unique index is built, so the index validates real data", () => {
    const backfillAt = code.indexOf(`UPDATE "CalendarEvent"`);
    const indexAt = code.indexOf(
      `CREATE UNIQUE INDEX "CalendarEvent_userId_provider_externalId_key"`,
    );
    expect(backfillAt).toBeGreaterThan(-1);
    expect(indexAt).toBeGreaterThan(backfillAt);
  });

  it("adds the (userId, provider, externalId) unique key", () => {
    expect(code).toContain(
      `CREATE UNIQUE INDEX "CalendarEvent_userId_provider_externalId_key" ON "CalendarEvent"("userId", "provider", "externalId");`,
    );
  });

  it("leaves googleId and its (userId, googleId) unique readable — the contract phase is later", () => {
    expect(code).not.toMatch(/"googleId" (DROP|TYPE|SET)|DROP COLUMN/);
    expect(code).not.toContain(`CalendarEvent_userId_googleId_key`);
  });
});

describe("calendar provider migration — additive only", () => {
  it("drops nothing except the one superseded LinkedCalendarAccount index", () => {
    const drops = code.match(/DROP (TABLE|COLUMN|TYPE|INDEX|CONSTRAINT)[^;]*;/g) ?? [];
    expect(drops).toEqual([`DROP INDEX "LinkedCalendarAccount_userId_email_key";`]);
    expect(code).not.toMatch(/TRUNCATE|DELETE FROM/);
  });

  it("schema.prisma carries the same shape", () => {
    const account = schema.match(/model LinkedCalendarAccount \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(account).toMatch(/provider\s+CalendarProvider\s+@default\(GOOGLE\)/);
    expect(account).toMatch(/accessToken\s+String\?/);
    expect(account).toMatch(/caldavUrl\s+String\?/);
    expect(account).toMatch(/caldavPasswordCipher\s+String\?/);
    expect(account).toContain("@@unique([userId, provider, email])");
    expect(account).not.toContain("@@unique([userId, email])");

    const event = schema.match(/model CalendarEvent \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(event).toMatch(/provider\s+CalendarProvider\s+@default\(GOOGLE\)/);
    expect(event).toMatch(/externalId\s+String\?/);
    expect(event).toMatch(/sourceAccountId\s+String\?/);
    expect(event).toMatch(/googleId\s+String\?/);
    expect(event).toContain("@@unique([userId, googleId])");
    expect(event).toContain("@@unique([userId, provider, externalId])");
  });
});
