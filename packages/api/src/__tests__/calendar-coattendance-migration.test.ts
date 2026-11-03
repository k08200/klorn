/**
 * Calendar co-attendance (founder decision 2026-11-01): two new tables,
 * ContactCoAttendance (per-contact counts and dates) and
 * CoAttendanceMeeting (the meetings already counted, by a hash). The SQL is
 * the contract for production, so its text is pinned; the CHECKs, the policies and
 * the fence triggers are invisible to Prisma and the CI drift check.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FENCED_MODELS } from "../privacy/data-wipe-fence.js";
import { findGaps, parseModels } from "./helpers/rls-coverage.js";

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, "..", "..", "prisma");
const migrationsDir = join(prismaDir, "migrations");
const MIGRATION = "20261101010000_calendar_coattendance";
/** The latest migration on main when this one was written. */
const AFTER = "20261031000000_sent_message_origin";

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

function columnsOf(model: string): string[] {
  const from = schema.slice(schema.indexOf(`model ${model} {`));
  return from
    .slice(0, from.indexOf("\n}"))
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//") && !line.startsWith("@@"))
    .map((line) => line.split(/\s+/)[0] ?? "")
    .filter((name) => name !== "user");
}

const COUNTS_TABLE = [
  `CREATE TABLE "ContactCoAttendance" (`,
  `"id" TEXT NOT NULL,`,
  `"userId" TEXT NOT NULL,`,
  `"contactEmail" TEXT NOT NULL,`,
  `"meetingCount" INTEGER NOT NULL DEFAULT 0,`,
  `"smallMeetingCount" INTEGER NOT NULL DEFAULT 0,`,
  `"firstMetAt" TIMESTAMP(3) NOT NULL,`,
  `"lastMetAt" TIMESTAMP(3) NOT NULL,`,
  `"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,`,
  `"updatedAt" TIMESTAMP(3) NOT NULL,`,
  `CONSTRAINT "ContactCoAttendance_pkey" PRIMARY KEY ("id"),`,
  `CONSTRAINT "ContactCoAttendance_contactEmail_normalized_check" CHECK ("contactEmail" = lower(btrim("contactEmail"))),`,
  `CONSTRAINT "ContactCoAttendance_counts_check" CHECK ("smallMeetingCount" >= 0 AND "smallMeetingCount" <= "meetingCount") )`,
].join(" ");

const MARKER_TABLE = [
  `CREATE TABLE "CoAttendanceMeeting" (`,
  `"id" TEXT NOT NULL,`,
  `"userId" TEXT NOT NULL,`,
  `"provider" "CalendarProvider" NOT NULL,`,
  `"eventKey" TEXT NOT NULL,`,
  `"endedAt" TIMESTAMP(3) NOT NULL,`,
  `"countedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,`,
  `CONSTRAINT "CoAttendanceMeeting_pkey" PRIMARY KEY ("id"),`,
  `CONSTRAINT "CoAttendanceMeeting_eventKey_sha256_check" CHECK ("eventKey" ~ '^[0-9a-f]{64}$') )`,
].join(" ");

describe("calendar co-attendance migration", () => {
  it("sorts after the latest migration on main", () => {
    const names = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(names.indexOf(AFTER));
  });

  it("creates exactly the two tables, their keys, and nothing else", () => {
    expect(statements).toEqual([
      `SET LOCAL lock_timeout = '5s'`,
      COUNTS_TABLE,
      MARKER_TABLE,
      `CREATE UNIQUE INDEX "ContactCoAttendance_userId_contactEmail_key" ON "ContactCoAttendance"("userId", "contactEmail")`,
      `CREATE INDEX "CoAttendanceMeeting_userId_endedAt_idx" ON "CoAttendanceMeeting"("userId", "endedAt")`,
      `CREATE UNIQUE INDEX "CoAttendanceMeeting_userId_provider_eventKey_key" ON "CoAttendanceMeeting"("userId", "provider", "eventKey")`,
      `ALTER TABLE "ContactCoAttendance" ADD CONSTRAINT "ContactCoAttendance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
      `ALTER TABLE "CoAttendanceMeeting" ADD CONSTRAINT "CoAttendanceMeeting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
      `ALTER TABLE "ContactCoAttendance" ENABLE ROW LEVEL SECURITY`,
      `CREATE POLICY "ContactCoAttendance_tenant_isolation" ON "ContactCoAttendance" USING ("userId" = current_setting('app.current_user_id', true))`,
      `CREATE POLICY "ContactCoAttendance_system_bypass" ON "ContactCoAttendance" USING (current_setting('app.bypass_rls', true) = 'on')`,
      `ALTER TABLE "CoAttendanceMeeting" ENABLE ROW LEVEL SECURITY`,
      `CREATE POLICY "CoAttendanceMeeting_tenant_isolation" ON "CoAttendanceMeeting" USING ("userId" = current_setting('app.current_user_id', true))`,
      `CREATE POLICY "CoAttendanceMeeting_system_bypass" ON "CoAttendanceMeeting" USING (current_setting('app.bypass_rls', true) = 'on')`,
      `CREATE TRIGGER "ContactCoAttendance_data_wipe_fence" BEFORE INSERT ON "ContactCoAttendance" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence()`,
      `CREATE TRIGGER "CoAttendanceMeeting_data_wipe_fence" BEFORE INSERT ON "CoAttendanceMeeting" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence()`,
    ]);
  });

  it("matches the schema's columns, and stores no attendee list, title or start", () => {
    expect(columnsOf("ContactCoAttendance")).toEqual([
      "id",
      "userId",
      "contactEmail",
      "meetingCount",
      "smallMeetingCount",
      "firstMetAt",
      "lastMetAt",
      "createdAt",
      "updatedAt",
    ]);
    expect(columnsOf("CoAttendanceMeeting")).toEqual([
      "id",
      "userId",
      "provider",
      "eventKey",
      "endedAt",
      "countedAt",
    ]);
    expect(sql).not.toMatch(/"attendees?"|"title"|"summary"|"startTime"|JSONB|TEXT\[\]/);
  });

  it("leaves both tables with RLS and their policies only, and fenced", () => {
    const models = parseModels(schema).filter((model) =>
      ["ContactCoAttendance", "CoAttendanceMeeting"].includes(model.table),
    );
    expect(models).toHaveLength(2);
    expect(
      findGaps(
        `ALTER TABLE IF EXISTS "_prisma_migrations" ENABLE ROW LEVEL SECURITY;\n${sql}`,
        models,
      ),
    ).toEqual([]);
    expect(FENCED_MODELS).toEqual(
      expect.arrayContaining(["ContactCoAttendance", "CoAttendanceMeeting"]),
    );
  });
});
