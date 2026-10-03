/**
 * RLS coverage guard (2026-10-03).
 *
 * Production is Supabase, which serves every table in `public` over its REST
 * API to the `anon` and `authenticated` roles. A table without Row-Level
 * Security is therefore readable and writable by anyone holding the project's
 * anon key. 18 model tables (plus `_prisma_migrations`) shipped that way,
 * because nothing made a new table's migration carry RLS. This test does: it
 * reads schema.prisma for every model's table and requires the migrations to
 * leave it with RLS enabled and the policies of docs/rls-rollout.md, word for
 * word.
 *
 * It reads migration text, not a database, so it proves a migration says the
 * right thing, not that production ran it. After a deploy, check the database:
 * the queries are in docs/rls-rollout.md.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, "..", "..", "prisma");
const migrationsDir = join(prismaDir, "migrations");

/**
 * Tables with no Prisma model. They must have RLS enabled, and need no policy:
 * RLS with no policy denies every row to every role that does not own the table
 * or bypass RLS. Each entry says why that is right for the table.
 */
const NON_MODEL_TABLES: Readonly<Record<string, string>> = {
  _prisma_migrations:
    "Prisma's bookkeeping. Only the migrating role reads or writes it, and that role owns it.",
};

/**
 * Models that deliberately have no RLS, with the reason. Empty on purpose. An
 * entry here means the table is open to any role that holds a privilege on it,
 * so add one only with that written down.
 */
const RLS_EXEMPT_MODELS: Readonly<Record<string, string>> = {};

/**
 * Tables with no "userId" whose tenant is their parent's. Each needs a tenant
 * policy through that parent. A table with no "userId" that is not listed here
 * is system-only: it gets the bypass policy and nothing else.
 */
const PARENT_SCOPED: Readonly<Record<string, { parent: string; foreignKey: string }>> = {
  Message: { parent: "Conversation", foreignKey: "conversationId" },
  ConversationSummary: { parent: "Conversation", foreignKey: "conversationId" },
  CommitmentPath: { parent: "Commitment", foreignKey: "commitmentId" },
};

const TENANT_ID = "current_setting('app.current_user_id', true)";
const BYPASS_ON = "current_setting('app.bypass_rls', true) = 'on'";

interface ModelTable {
  table: string;
  hasUserId: boolean;
}

interface Policy {
  name: string;
  line: string;
}

interface Gap {
  table: string;
  missingLines: string[];
}

function stripLineComments(text: string, marker: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith(marker))
    .join("\n");
}

function parseModels(schema: string): ModelTable[] {
  const models = stripLineComments(schema, "//").matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm);
  return [...models].map(([, name, body]) => ({
    table: /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? name,
    hasUserId: /^\s*userId\s/m.test(body),
  }));
}

function readMigrations(): string {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => readFileSync(join(migrationsDir, name, "migration.sql"), "utf8"))
    .join("\n");
}

/** The statement as a pattern: the same text, with any whitespace between its words. */
function asPattern(statement: string): RegExp {
  const escaped = statement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped.replace(/\s+/g, "\\s+"), "g");
}

function lastIndexOf(sql: string, pattern: RegExp): number {
  return [...sql.matchAll(pattern)].at(-1)?.index ?? -1;
}

function enableLine(table: string): string {
  return `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`;
}

/** True when the last statement to set the table's RLS state enables it. */
function rlsEnabled(sql: string, table: string): boolean {
  const statement = (verb: string) =>
    new RegExp(
      `ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?"${table}"\\s+${verb}\\s+ROW\\s+LEVEL\\s+SECURITY`,
      "g",
    );
  return lastIndexOf(sql, statement("ENABLE")) > lastIndexOf(sql, statement("DISABLE"));
}

function tenantCondition({ table, hasUserId }: ModelTable): string | null {
  if (hasUserId) return `"userId" = ${TENANT_ID}`;
  const scope = PARENT_SCOPED[table];
  if (!scope) return null;
  return `EXISTS (SELECT 1 FROM "${scope.parent}" parent WHERE parent."id" = "${table}"."${scope.foreignKey}" AND parent."userId" = ${TENANT_ID})`;
}

function policy(table: string, kind: string, condition: string): Policy {
  const name = `${table}_${kind}`;
  return { name, line: `CREATE POLICY "${name}" ON "${table}" USING (${condition});` };
}

function expectedPolicies(model: ModelTable): Policy[] {
  const tenant = tenantCondition(model);
  return [
    ...(tenant ? [policy(model.table, "tenant_isolation", tenant)] : []),
    policy(model.table, "system_bypass", BYPASS_ON),
  ];
}

/** True when the policy is created with exactly this condition and not dropped afterwards. */
function policyStands(sql: string, table: string, { name, line }: Policy): boolean {
  const dropped = new RegExp(
    `DROP\\s+POLICY\\s+(?:IF\\s+EXISTS\\s+)?"${name}"\\s+ON\\s+"${table}"`,
    "g",
  );
  return lastIndexOf(sql, asPattern(line)) > lastIndexOf(sql, dropped);
}

function findGap(sql: string, model: ModelTable): Gap {
  const policies = expectedPolicies(model).filter((item) => !policyStands(sql, model.table, item));
  return {
    table: model.table,
    missingLines: [
      ...(rlsEnabled(sql, model.table) ? [] : [enableLine(model.table)]),
      ...policies.map((item) => item.line),
    ],
  };
}

function findGaps(sql: string, models: readonly ModelTable[]): Gap[] {
  return models
    .filter((model) => !(model.table in RLS_EXEMPT_MODELS))
    .map((model) => findGap(sql, model))
    .filter((gap) => gap.missingLines.length > 0);
}

function explain(gaps: readonly Gap[]): string {
  const blocks = gaps.map((gap) => [`-- ${gap.table}`, ...gap.missingLines].join("\n"));
  return [
    `${gaps.length} table(s) in schema.prisma are missing Row-Level Security: ${gaps.map((gap) => gap.table).join(", ")}.`,
    "Supabase serves every table in `public` over its REST API, so a table without RLS is open to anyone holding the anon key.",
    "Add exactly these lines to the migration that creates the table (see docs/rls-rollout.md):",
    "",
    blocks.join("\n\n"),
    "",
    'A table with no "userId" column gets no tenant line: it is system-only. If its parent has a "userId", list it in PARENT_SCOPED in this file and the tenant line through the parent is printed, as for "Message".',
  ].join("\n");
}

const schema = readFileSync(join(prismaDir, "schema.prisma"), "utf8");
const migrations = stripLineComments(readMigrations(), "--");
const models = parseModels(schema);

describe("RLS coverage guard", () => {
  it("reads every model in schema.prisma", () => {
    // A parser that silently finds nothing would make every check below pass.
    const declared = schema.split("\n").filter((line) => /^model\s+\w+\s*\{/.test(line));
    expect(models.length).toBeGreaterThan(0);
    expect(models).toHaveLength(declared.length);
    expect(models.find((model) => model.table === "User")?.hasUserId).toBe(false);
    expect(models.find((model) => model.table === "Device")?.hasUserId).toBe(true);
  });

  it("every model's table has RLS enabled with its policies", () => {
    const gaps = findGaps(migrations, models);
    expect(
      gaps.map((gap) => gap.table),
      explain(gaps),
    ).toEqual([]);
  });

  it("every table without a model has RLS enabled", () => {
    const open = Object.keys(NON_MODEL_TABLES).filter((table) => !rlsEnabled(migrations, table));
    expect(
      open,
      `Add \`ALTER TABLE IF EXISTS "<table>" ENABLE ROW LEVEL SECURITY;\` for each.`,
    ).toEqual([]);
  });

  it("the lists above name real models, so they cannot go stale", () => {
    const userIdOf = new Map(models.map((model) => [model.table, model.hasUserId]));
    expect(Object.keys(RLS_EXEMPT_MODELS).filter((table) => !userIdOf.has(table))).toEqual([]);
    for (const [table, { parent }] of Object.entries(PARENT_SCOPED)) {
      expect(userIdOf.get(table), `${table} has its own "userId"`).toBe(false);
      expect(userIdOf.get(parent), `${parent}, parent of ${table}, has no "userId"`).toBe(true);
    }
  });
});

describe("RLS coverage guard: the checks themselves", () => {
  const owned: ModelTable = { table: "Thing", hasUserId: true };
  const system: ModelTable = { table: "Ledger", hasUserId: false };
  const child: ModelTable = { table: "Message", hasUserId: false };
  const complete = [
    `ALTER TABLE "Thing" ENABLE ROW LEVEL SECURITY;`,
    `CREATE POLICY "Thing_tenant_isolation" ON "Thing" USING ("userId" = current_setting('app.current_user_id', true));`,
    `CREATE POLICY "Thing_system_bypass" ON "Thing" USING (current_setting('app.bypass_rls', true) = 'on');`,
  ];
  const [enable, tenant, bypass] = complete;
  const sql = complete.join("\n");

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
    expect(findGaps(sql, [owned])).toEqual([]);
    expect(findGaps(sql.replaceAll(" USING ", "\n  USING "), [owned])).toEqual([]);
  });

  it("names all three lines for a table with a userId and nothing else", () => {
    expect(findGaps("", [owned])).toEqual([{ table: "Thing", missingLines: complete }]);
  });

  it("names only the line that is missing", () => {
    expect(findGaps([enable, bypass].join("\n"), [owned])[0]?.missingLines).toEqual([tenant]);
  });

  it("asks a system table with no userId for the bypass policy only", () => {
    expect(findGaps("", [system])[0]?.missingLines).toEqual([
      `ALTER TABLE "Ledger" ENABLE ROW LEVEL SECURITY;`,
      `CREATE POLICY "Ledger_system_bypass" ON "Ledger" USING (current_setting('app.bypass_rls', true) = 'on');`,
    ]);
  });

  it("asks a parent-scoped table for the tenant policy through its parent", () => {
    expect(findGaps("", [child])[0]?.missingLines).toEqual([
      `ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;`,
      `CREATE POLICY "Message_tenant_isolation" ON "Message" USING (EXISTS (SELECT 1 FROM "Conversation" parent WHERE parent."id" = "Message"."conversationId" AND parent."userId" = current_setting('app.current_user_id', true)));`,
      `CREATE POLICY "Message_system_bypass" ON "Message" USING (current_setting('app.bypass_rls', true) = 'on');`,
    ]);
  });

  it("fails a policy with the right name and another condition", () => {
    const open = sql.replace(`(current_setting('app.bypass_rls', true) = 'on')`, "(true)");
    expect(findGaps(open, [owned])[0]?.missingLines).toEqual([bypass]);
  });

  it("fails a table whose RLS a later migration disables", () => {
    const disabled = `${sql}\nALTER TABLE "Thing" DISABLE ROW LEVEL SECURITY;`;
    expect(findGaps(disabled, [owned])[0]?.missingLines).toEqual([enable]);
  });

  it("fails a policy that a later migration drops, and passes one that is recreated", () => {
    const dropped = `${sql}\nDROP POLICY "Thing_system_bypass" ON "Thing";`;
    expect(findGaps(dropped, [owned])[0]?.missingLines).toEqual([bypass]);
    const recreated = `DROP POLICY IF EXISTS "Thing_system_bypass" ON "Thing";\n${sql}`;
    expect(findGaps(recreated, [owned])).toEqual([]);
  });

  it("puts the missing lines in the failure message", () => {
    const message = explain(findGaps("", [owned, system]));
    expect(message).toContain("2 table(s)");
    expect(message).toContain(sql);
    expect(message).toContain(`ALTER TABLE "Ledger" ENABLE ROW LEVEL SECURITY;`);
  });
});
