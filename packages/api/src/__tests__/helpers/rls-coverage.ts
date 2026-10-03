/**
 * The checks behind rls-coverage-guard.test.ts: which tables exist, what
 * Row-Level Security each must have, and what the migrations leave it with.
 *
 * Everything here reads text. It finds a table two ways, from a model in
 * schema.prisma and from a `CREATE TABLE` in a migration, so a raw-SQL table or
 * an implicit many-to-many table cannot go unseen. A table may hold exactly the
 * policies listed for it and no other: one extra permissive policy is enough to
 * open a table, whatever the expected ones say.
 */

/**
 * Tables that no model and no migration creates. They must have RLS enabled and
 * may have no policy: RLS with no policy denies every row to every role that
 * does not own the table or bypass RLS. Each entry says why that is right.
 */
export const NON_MODEL_TABLES: Readonly<Record<string, string>> = {
  _prisma_migrations:
    "Prisma's bookkeeping. Only the migrating role reads or writes it, and that role owns it.",
};

/**
 * Tables that deliberately have no RLS, with the reason. Empty on purpose. An
 * entry here means the table is open to any role that holds a privilege on it,
 * so add one only with that written down.
 */
export const RLS_EXEMPT_TABLES: Readonly<Record<string, string>> = {};

/**
 * Tables with no "userId" whose tenant is their parent's. Each needs a tenant
 * policy through that parent. A table with no "userId" that is listed neither
 * here nor in OWN_KEY is system-only: it gets the bypass policy and nothing else.
 */
export const PARENT_SCOPED: Readonly<Record<string, { parent: string; foreignKey: string }>> = {
  Message: { parent: "Conversation", foreignKey: "conversationId" },
  ConversationSummary: { parent: "Conversation", foreignKey: "conversationId" },
  CommitmentPath: { parent: "Commitment", foreignKey: "commitmentId" },
};

/** Tables whose own key is the tenant: a user's row in "User" is the one with their id. */
export const OWN_KEY: Readonly<Record<string, string>> = { User: "id" };

const TENANT_ID = "current_setting('app.current_user_id', true)";
const BYPASS_ON = "current_setting('app.bypass_rls', true) = 'on'";

/** A table name as SQL writes it: quoted or bare, with or without the schema. */
const TABLE_NAME = String.raw`(?:(?:"public"|public)\s*\.\s*)?("[^"]+"|\w+)`;

export interface TableSpec {
  table: string;
  hasUserId: boolean;
}

export interface Gap {
  table: string;
  rlsOff: boolean;
  /** Expected policies that do not stand at all. */
  policiesMissing: string[];
  /** Policies that stand and may not: an extra one, or an expected one that was changed. */
  policiesNotAllowed: string[];
  /** The statements that close the gap, in the order to run them. */
  lines: string[];
}

interface Policy {
  name: string;
  line: string;
}

type PolicyState = { kind: "created"; text: string } | { kind: "altered" } | { kind: "dropped" };

function unquote(name: string): string {
  return name.replace(/^"|"$/g, "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The same text with nothing but its statements: no `--` comment, no block comment. */
export function stripComments(sql: string): string {
  // Line comments first: their prose can hold a "/*" (a glob in a path) that
  // would otherwise open a block comment and swallow the statements after it.
  return sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, " ");
}

export function parseModels(schema: string): TableSpec[] {
  const withoutComments = schema
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  const models = withoutComments.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm);
  return [...models].map(([, name, body]) => ({
    table: /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? name,
    hasUserId: /^\s*userId\s/m.test(body),
  }));
}

function lastIndexOf(sql: string, pattern: RegExp): number {
  return [...sql.matchAll(pattern)].at(-1)?.index ?? -1;
}

function lastCreate(sql: string, table: string): number {
  const name = escapeRegExp(table);
  const created = new RegExp(
    String.raw`CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"public"|public)\s*\.\s*)?(?:"${name}"|${name}\b)`,
    "gi",
  );
  return lastIndexOf(sql, created);
}

function lastDrop(sql: string, table: string): number {
  const drops = sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^;]+);/gi);
  const naming = [...drops].filter(([, list]) =>
    list
      .replace(/\b(?:CASCADE|RESTRICT)\b/gi, "")
      .split(",")
      .some((item) => unquote(item.trim().replace(/^(?:"public"|public)\s*\.\s*/, "")) === table),
  );
  return naming.at(-1)?.index ?? -1;
}

/** Tables a migration creates and no later migration drops. `sql` has no comments. */
export function tablesFromMigrations(sql: string): TableSpec[] {
  const created = sql.matchAll(
    new RegExp(
      String.raw`CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${TABLE_NAME}`,
      "gi",
    ),
  );
  const names = [...new Set([...created].map(([, name]) => unquote(name)))];
  return names
    .filter((table) => lastCreate(sql, table) > lastDrop(sql, table))
    .map((table) => {
      const from = lastCreate(sql, table);
      const statement = sql.slice(from, sql.indexOf(";", from));
      const added = new RegExp(
        String.raw`ALTER\s+TABLE\s+"${escapeRegExp(table)}"[^;]*ADD\s+COLUMN\s+"userId"`,
      );
      return { table, hasUserId: statement.includes('"userId"') || added.test(sql.slice(from)) };
    });
}

/** Every table to check: the models, then whatever else the migrations create. */
function tablesToCheck(sql: string, models: readonly TableSpec[]): TableSpec[] {
  const known = new Set(models.map((model) => model.table));
  const others = [
    ...tablesFromMigrations(sql),
    ...Object.keys(NON_MODEL_TABLES).map((table) => ({ table, hasUserId: false })),
  ].filter((spec) => !known.has(spec.table));
  return [...models, ...others].filter((spec) => !(spec.table in RLS_EXEMPT_TABLES));
}

function enableLine(table: string): string {
  // A table Prisma creates outside the migrations is missing from a shadow database.
  const guard = table in NON_MODEL_TABLES ? "IF EXISTS " : "";
  return `ALTER TABLE ${guard}"${table}" ENABLE ROW LEVEL SECURITY;`;
}

/** True when the last statement to set the table's RLS state enables it. */
function rlsEnabled(sql: string, table: string): boolean {
  const statement = (verb: string) =>
    new RegExp(
      String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"${escapeRegExp(table)}"\s+${verb}\s+ROW\s+LEVEL\s+SECURITY`,
      "gi",
    );
  return lastIndexOf(sql, statement("ENABLE")) > lastIndexOf(sql, statement("DISABLE"));
}

function tenantCondition({ table, hasUserId }: TableSpec): string | null {
  if (hasUserId) return `"userId" = ${TENANT_ID}`;
  if (table in OWN_KEY) return `"${OWN_KEY[table]}" = ${TENANT_ID}`;
  const scope = PARENT_SCOPED[table];
  if (!scope) return null;
  return `EXISTS (SELECT 1 FROM "${scope.parent}" parent WHERE parent."id" = "${table}"."${scope.foreignKey}" AND parent."userId" = ${TENANT_ID})`;
}

function policy(table: string, kind: string, condition: string): Policy {
  const name = `${table}_${kind}`;
  return { name, line: `CREATE POLICY "${name}" ON "${table}" USING (${condition});` };
}

function expectedPolicies(spec: TableSpec): Policy[] {
  if (spec.table in NON_MODEL_TABLES) return [];
  const tenant = tenantCondition(spec);
  return [
    ...(tenant ? [policy(spec.table, "tenant_isolation", tenant)] : []),
    policy(spec.table, "system_bypass", BYPASS_ON),
  ];
}

/** What the migrations leave each policy on the table as: the last statement about it wins. */
function policyStates(sql: string, table: string): Map<string, PolicyState> {
  const statements = sql.matchAll(
    new RegExp(
      String.raw`(CREATE|ALTER|DROP)\s+POLICY\s+(?:IF\s+EXISTS\s+)?("[^"]+"|\w+)\s+ON\s+${TABLE_NAME}[^;]*;`,
      "gi",
    ),
  );
  const states = new Map<string, PolicyState>();
  for (const [text, verb, name, onTable] of statements) {
    if (unquote(onTable) !== table) continue;
    const kind = verb.toUpperCase();
    const state: PolicyState =
      kind === "CREATE"
        ? { kind: "created", text }
        : kind === "ALTER"
          ? { kind: "altered" }
          : { kind: "dropped" };
    states.set(unquote(name), state);
  }
  return states;
}

function compact(statement: string): string {
  return statement.replace(/\s+/g, "");
}

function findGap(sql: string, spec: TableSpec): Gap {
  const { table } = spec;
  // RLS and policies go with the table: one dropped and created again has none,
  // so only what follows the last DROP TABLE counts.
  const scope = sql.slice(Math.max(lastDrop(sql, table), 0));
  const expected = expectedPolicies(spec);
  const states = policyStates(scope, table);
  const stands = (name: string) => (states.get(name)?.kind ?? "dropped") !== "dropped";
  const asExpected = ({ name, line }: Policy) => {
    const state = states.get(name);
    return state?.kind === "created" && compact(state.text) === compact(line);
  };

  const rlsOff = !rlsEnabled(scope, table);
  const toCreate = expected.filter((item) => !asExpected(item));
  const absent = toCreate.filter((item) => !stands(item.name)).map((item) => item.name);
  const changed = toCreate.filter((item) => stands(item.name)).map((item) => item.name);
  const extra = [...states.keys()].filter(
    (name) => stands(name) && !expected.some((item) => item.name === name),
  );
  const notAllowed = [...extra, ...changed];

  return {
    table,
    rlsOff,
    policiesMissing: absent,
    policiesNotAllowed: notAllowed,
    lines: [
      ...notAllowed.map((name) => `DROP POLICY "${name}" ON "${table}";`),
      ...(rlsOff ? [enableLine(table)] : []),
      ...toCreate.map((item) => item.line),
    ],
  };
}

/** Every table the migrations do not leave with the RLS it must have. */
export function findGaps(migrationsSql: string, models: readonly TableSpec[]): Gap[] {
  const sql = stripComments(migrationsSql);
  return tablesToCheck(sql, models)
    .map((spec) => findGap(sql, spec))
    .filter((gap) => gap.lines.length > 0);
}

function headline(label: string, tables: readonly string[]): string[] {
  return tables.length > 0 ? [`${label} (${tables.length}): ${tables.join(", ")}`] : [];
}

export function explain(gaps: readonly Gap[]): string {
  const tablesWhere = (test: (gap: Gap) => boolean) => gaps.filter(test).map((gap) => gap.table);
  const blocks = gaps.map((gap) => [`-- ${gap.table}`, ...gap.lines].join("\n"));
  return [
    `${gaps.length} table(s) do not have the Row-Level Security that docs/rls-rollout.md requires.`,
    ...headline(
      "RLS not enabled",
      tablesWhere((gap) => gap.rlsOff),
    ),
    ...headline(
      "Policy missing",
      tablesWhere((gap) => gap.policiesMissing.length > 0),
    ),
    ...headline(
      "Policy not allowed",
      tablesWhere((gap) => gap.policiesNotAllowed.length > 0),
    ),
    "Supabase serves every table in `public` over its REST API, so a table without RLS is open to anyone holding the anon key, and one permissive policy too many opens it again.",
    "Add exactly these lines to the migration that creates the table (see docs/rls-rollout.md):",
    "",
    blocks.join("\n\n"),
    "",
    'A table with no "userId" column gets no tenant line: it is system-only. If its parent has a "userId", list it in PARENT_SCOPED in helpers/rls-coverage.ts and the tenant line through the parent is printed, as for "Message".',
  ].join("\n");
}
