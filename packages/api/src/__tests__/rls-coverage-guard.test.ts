/**
 * RLS coverage guard (2026-10-03).
 *
 * Production is Supabase, which serves every table in `public` over its REST
 * API to the `anon` and `authenticated` roles. A table without Row-Level
 * Security is therefore readable and writable by anyone holding the project's
 * anon key. 18 model tables (plus `_prisma_migrations`) shipped that way,
 * because nothing made a new table's migration carry RLS. This test does: for
 * every model in schema.prisma and every table a migration creates, the
 * migrations must leave RLS enabled and exactly the policies of
 * docs/rls-rollout.md, word for word, and no other policy.
 *
 * It reads migration text, not a database, so it proves a migration says the
 * right thing, not that production ran it. After a deploy, check the database:
 * the queries are in docs/rls-rollout.md. The checks are in
 * helpers/rls-coverage.ts.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  explain,
  findGaps,
  OWN_KEY,
  PARENT_SCOPED,
  parseModels,
  RLS_EXEMPT_TABLES,
  stripComments,
  type TableSpec,
  tablesFromMigrations,
} from "./helpers/rls-coverage.js";

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, "..", "..", "prisma");
const migrationsDir = join(prismaDir, "migrations");

function readMigrations(): string {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => readFileSync(join(migrationsDir, name, "migration.sql"), "utf8"))
    .join("\n");
}

const schema = readFileSync(join(prismaDir, "schema.prisma"), "utf8");
const migrations = readMigrations();
const models = parseModels(schema);

describe("RLS coverage guard", () => {
  it("reads every model in schema.prisma, and finds each one's table in the migrations", () => {
    // A parser that silently finds nothing would make the check below pass.
    const declared = schema.split("\n").filter((line) => /^model\s+\w+\s*\{/.test(line));
    expect(models.length).toBeGreaterThan(0);
    expect(models).toHaveLength(declared.length);
    expect(models.find((model) => model.table === "User")?.hasUserId).toBe(false);
    expect(models.find((model) => model.table === "Device")?.hasUserId).toBe(true);

    const created = tablesFromMigrations(stripComments(migrations));
    const createdNames = new Set(created.map((spec) => spec.table));
    expect(models.filter((model) => !createdNames.has(model.table))).toEqual([]);
    const userIdInSchema = new Map(models.map((model) => [model.table, model.hasUserId]));
    expect(
      created.filter(
        (spec) => (userIdInSchema.get(spec.table) ?? spec.hasUserId) !== spec.hasUserId,
      ),
    ).toEqual([]);
  });

  it("every table has RLS enabled, with its policies and no other", () => {
    const gaps = findGaps(migrations, models);
    expect(
      gaps.map((gap) => gap.table),
      explain(gaps),
    ).toEqual([]);
  });

  it("the lists in the helper name real models, so they cannot go stale", () => {
    const userIdOf = new Map(models.map((model) => [model.table, model.hasUserId]));
    expect(Object.keys(RLS_EXEMPT_TABLES).filter((table) => !userIdOf.has(table))).toEqual([]);
    for (const table of Object.keys(OWN_KEY)) {
      expect(userIdOf.get(table), `${table} has its own "userId"`).toBe(false);
    }
    for (const [table, { parent }] of Object.entries(PARENT_SCOPED)) {
      expect(userIdOf.get(table), `${table} has its own "userId"`).toBe(false);
      expect(userIdOf.get(parent), `${parent}, parent of ${table}, has no "userId"`).toBe(true);
    }
  });
});

describe("RLS coverage guard: the checks themselves", () => {
  const owned: TableSpec = { table: "Thing", hasUserId: true };
  const system: TableSpec = { table: "Ledger", hasUserId: false };
  const child: TableSpec = { table: "Message", hasUserId: false };
  const complete = [
    `ALTER TABLE "Thing" ENABLE ROW LEVEL SECURITY;`,
    `CREATE POLICY "Thing_tenant_isolation" ON "Thing" USING ("userId" = current_setting('app.current_user_id', true));`,
    `CREATE POLICY "Thing_system_bypass" ON "Thing" USING (current_setting('app.bypass_rls', true) = 'on');`,
  ];
  const [enable, tenant, bypass] = complete;
  const sql = complete.join("\n");
  // The table Prisma keeps outside the migrations is always checked, so every
  // text below enables RLS on it, to leave only the table under test.
  const base = `ALTER TABLE IF EXISTS "_prisma_migrations" ENABLE ROW LEVEL SECURITY;`;
  const gapsIn = (text: string, specs: readonly TableSpec[]) => findGaps(`${base}\n${text}`, specs);
  const tablesIn = (text: string, specs: readonly TableSpec[]) =>
    gapsIn(text, specs).map((gap) => gap.table);

  it("reads a mapped table name and the userId field", () => {
    const parsed = parseModels(
      `model Thing {\n  id String @id\n  userId String\n  @@map("things")\n}\nmodel Ledger {\n  // userId is not a field here\n  day String @id\n}\n`,
    );
    expect(parsed).toEqual([
      { table: "things", hasUserId: true },
      { table: "Ledger", hasUserId: false },
    ]);
  });

  it("passes a table with all three lines, however they are wrapped", () => {
    expect(gapsIn(sql, [owned])).toEqual([]);
    expect(gapsIn(sql.replaceAll(" USING ", "\n  USING "), [owned])).toEqual([]);
  });

  it("names all three lines for a table with a userId and nothing else", () => {
    expect(gapsIn("", [owned])[0]?.lines).toEqual(complete);
  });

  it("names only the line that is missing", () => {
    expect(gapsIn([enable, bypass].join("\n"), [owned])[0]?.lines).toEqual([tenant]);
  });

  it("asks a system table with no userId for the bypass policy only", () => {
    expect(gapsIn("", [system])[0]?.lines).toEqual([
      `ALTER TABLE "Ledger" ENABLE ROW LEVEL SECURITY;`,
      `CREATE POLICY "Ledger_system_bypass" ON "Ledger" USING (current_setting('app.bypass_rls', true) = 'on');`,
    ]);
  });

  it("asks a parent-scoped table for the tenant policy through its parent", () => {
    expect(gapsIn("", [child])[0]?.lines).toEqual([
      `ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;`,
      `CREATE POLICY "Message_tenant_isolation" ON "Message" USING (EXISTS (SELECT 1 FROM "Conversation" parent WHERE parent."id" = "Message"."conversationId" AND parent."userId" = current_setting('app.current_user_id', true)));`,
      `CREATE POLICY "Message_system_bypass" ON "Message" USING (current_setting('app.bypass_rls', true) = 'on');`,
    ]);
  });

  it("asks the table Prisma keeps outside the migrations for RLS and no policy", () => {
    expect(findGaps("", [])).toMatchObject([{ table: "_prisma_migrations", lines: [base] }]);
    const withPolicy = `${base}\nCREATE POLICY "open" ON "_prisma_migrations" USING (true);`;
    expect(findGaps(withPolicy, [])[0]?.lines).toEqual([
      `DROP POLICY "open" ON "_prisma_migrations";`,
    ]);
  });

  it("fails a policy with the right name and another condition", () => {
    const open = sql.replace(`(current_setting('app.bypass_rls', true) = 'on')`, "(true)");
    expect(gapsIn(open, [owned])[0]?.lines).toEqual([
      `DROP POLICY "Thing_system_bypass" ON "Thing";`,
      bypass,
    ]);
  });

  it("fails a table whose RLS a later migration disables", () => {
    const disabled = `${sql}\nALTER TABLE "Thing" DISABLE ROW LEVEL SECURITY;`;
    expect(gapsIn(disabled, [owned])[0]?.lines).toEqual([enable]);
  });

  it("fails a policy that a later migration drops, and passes one that is recreated", () => {
    const dropped = `${sql}\nDROP POLICY "Thing_system_bypass" ON "Thing";`;
    expect(gapsIn(dropped, [owned])[0]?.lines).toEqual([bypass]);
    const recreated = `DROP POLICY IF EXISTS "Thing_system_bypass" ON "Thing";\n${sql}`;
    expect(gapsIn(recreated, [owned])).toEqual([]);
  });

  it("finds a table that only a migration creates, and reads its userId column", () => {
    const joinTable = `CREATE TABLE "_ThingToLedger" ("A" TEXT NOT NULL, "B" TEXT NOT NULL);`;
    expect(tablesIn(joinTable, [])).toEqual(["_ThingToLedger"]);
    const raw = `CREATE TABLE IF NOT EXISTS "Raw" (\n  "id" TEXT NOT NULL,\n  "userId" TEXT NOT NULL\n);`;
    expect(explain(gapsIn(raw, []))).toContain(
      `CREATE POLICY "Raw_tenant_isolation" ON "Raw" USING ("userId" = current_setting('app.current_user_id', true));`,
    );
    expect(tablesIn(`create table public.bare (id text);`, [])).toEqual(["bare"]);
  });

  it("forgets a table that a later migration drops", () => {
    const dropped = `CREATE TABLE "Gone" ("id" TEXT);\nDROP TABLE IF EXISTS "Gone" CASCADE;`;
    expect(gapsIn(dropped, [])).toEqual([]);
    const both = `CREATE TABLE "Gone" ("id" TEXT);\nCREATE TABLE "Kept" ("id" TEXT);\nDROP TABLE "Gone", "Other";`;
    expect(tablesIn(both, [])).toEqual(["Kept"]);
  });

  it("does not carry RLS over to a table that is dropped and created again", () => {
    const created = `CREATE TABLE "Thing" ("id" TEXT, "userId" TEXT);`;
    const again = `${created}\n${sql}\nDROP TABLE "Thing";\n${created}`;
    expect(tablesIn(again, [owned])).toEqual(["Thing"]);
    expect(
      gapsIn(`${created}\n${sql}\n${created.replace("TABLE", "TABLE IF NOT EXISTS")}`, [owned]),
    ).toEqual([]);
  });

  it("does not count a statement inside a comment", () => {
    expect(tablesIn(`/*\n${sql}\n*/`, [owned])).toEqual(["Thing"]);
    const trailing = complete.map((line) => `SELECT 1; -- ${line}`).join("\n");
    expect(tablesIn(trailing, [owned])).toEqual(["Thing"]);
    const glob = `-- see packages/*/README\n${sql}\n-- and docs/*/index`;
    expect(gapsIn(glob, [owned])).toEqual([]);
  });

  it("fails a table with a policy it may not have", () => {
    const open = `${sql}\nCREATE POLICY "Thing_open" ON "Thing" USING (true);`;
    expect(tablesIn(open, [owned])).toEqual(["Thing"]);
    expect(explain(gapsIn(open, [owned]))).toContain(`DROP POLICY "Thing_open" ON "Thing";`);
    const forAnon = `${sql}\nCREATE POLICY "Thing_read" ON "Thing" FOR SELECT TO anon USING ("id" IS NOT NULL);`;
    expect(tablesIn(forAnon, [owned])).toEqual(["Thing"]);
    const lowercase = `${sql}\ncreate policy thing_open on "Thing" using (true);`;
    expect(tablesIn(lowercase, [owned])).toEqual(["Thing"]);
    const removed = `${open}\nDROP POLICY "Thing_open" ON "Thing";`;
    expect(gapsIn(removed, [owned])).toEqual([]);
  });

  it("fails a policy that a later ALTER POLICY changes", () => {
    const weakened = `${sql}\nALTER POLICY "Thing_system_bypass" ON "Thing" USING (true);`;
    expect(tablesIn(weakened, [owned])).toEqual(["Thing"]);
    const restored = `${weakened}\nDROP POLICY "Thing_system_bypass" ON "Thing";\n${bypass}`;
    expect(gapsIn(restored, [owned])).toEqual([]);
  });

  it("says in the headline whether RLS is off or a policy is the problem", () => {
    const rlsOff = [tenant, bypass].join("\n");
    const noPolicy = `ALTER TABLE "Ledger" ENABLE ROW LEVEL SECURITY;`;
    const extra = `ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;\nCREATE POLICY "Message_open" ON "Message" USING (true);`;
    const message = explain(gapsIn([rlsOff, noPolicy, extra].join("\n"), [owned, system, child]));
    expect(message).toContain("3 table(s)");
    expect(message).toContain("RLS not enabled (1): Thing");
    expect(message).toContain("Policy missing (2): Ledger, Message");
    expect(message).toContain("Policy not allowed (1): Message");
  });

  it("puts the missing lines in the failure message", () => {
    const message = explain(gapsIn("", [owned, system]));
    expect(message).toContain("2 table(s)");
    expect(message).toContain(sql);
    expect(message).toContain(`ALTER TABLE "Ledger" ENABLE ROW LEVEL SECURITY;`);
  });
});
