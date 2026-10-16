/**
 * A strict in-memory stand-in for the Prisma models the tier-learning readers,
 * set_tier and the re-judge paths touch. It EVALUATES the `where` each caller
 * builds, so a test proves what a real reader would do with the rows, not just
 * that it issued a query.
 *
 * "Strict" is the point. A lenient fake lets a wrong query pass: a misspelt
 * field, `{tier: {not: "X"}}` matching NULL rows, a missing key satisfying both
 * `{x: null}` and `{x: {not: null}}`. So this one is checked against the real
 * schema (`Prisma.dmmf`):
 *   - every key in `where`, `data`, `select`, `orderBy` and every seeded row must
 *     be a real column of the model; an unknown key throws;
 *   - undefined is coerced to NULL in rows, and `@default` values are applied;
 *   - SQL semantics: any comparison against NULL is false, including
 *     `{not: value}`; a null filter on a required column throws;
 *   - `upsert` evaluates its `where` and applies `update` or `create`;
 *   - create enforces required columns and unique keys; `@updatedAt` is set;
 *   - any argument or operator it does not implement throws instead of being
 *     ignored, so a new query shape fails loudly.
 *
 * Every model records its writes (`writes.<model>`) and every read (`reads`), so a
 * test can assert that a code path never touched a table.
 */

import { Prisma } from "@prisma/client";

export type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
type Select = Record<string, boolean>;

// ─── Schema knowledge (from the real Prisma datamodel) ──────────────────────

interface Field {
  name: string;
  kind: string;
  isRequired: boolean;
  isUpdatedAt: boolean;
  isId: boolean;
  isUnique: boolean;
  hasDefaultValue: boolean;
  default?: unknown;
  type: string;
}

interface ModelInfo {
  name: string;
  columns: Map<string, Field>;
  /** compound-key name -> its column names (`userId_source_sourceId`). */
  compound: Map<string, string[]>;
  /** every unique column set: single columns, ids and compound keys. */
  uniqueSets: string[][];
  /** relation field -> how a row of this model meets the rows of the other. */
  relations: Map<string, Relation>;
}

/** row[ownKeys[i]] === other[otherKeys[i]] for every i, in model `target`. */
interface Relation {
  target: string;
  ownKeys: string[];
  otherKeys: string[];
}

type DmmfModel = (typeof Prisma.dmmf.datamodel.models)[number];

/** Both sides of a relation: the forward side names its keys, the back side borrows them. */
function relationsOf(model: DmmfModel, all: readonly DmmfModel[]): Map<string, Relation> {
  const relations = new Map<string, Relation>();
  for (const f of model.fields) {
    if (f.kind !== "object") continue;
    const target = lowerFirst(f.type);
    const from = f.relationFromFields ?? [];
    if (from.length > 0) {
      relations.set(f.name, {
        target,
        ownKeys: [...from],
        otherKeys: [...(f.relationToFields ?? [])],
      });
      continue;
    }
    const other = all
      .find((m) => m.name === f.type)
      ?.fields.find(
        (g) => g.relationName === f.relationName && (g.relationFromFields ?? []).length > 0,
      );
    if (!other) continue;
    relations.set(f.name, {
      target,
      ownKeys: [...(other.relationToFields ?? [])],
      otherKeys: [...(other.relationFromFields ?? [])],
    });
  }
  return relations;
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

function buildModelInfo(model: DmmfModel, all: readonly DmmfModel[]): ModelInfo {
  const columns = new Map<string, Field>();
  for (const f of model.fields) {
    if (f.kind === "scalar" || f.kind === "enum") columns.set(f.name, f as unknown as Field);
  }
  const compound = new Map<string, string[]>();
  const sets: string[][] = [];
  const addCompound = (name: string | null, fields: readonly string[]) => {
    if (fields.length < 2) return;
    compound.set(name ?? fields.join("_"), [...fields]);
    sets.push([...fields]);
  };
  for (const u of model.uniqueIndexes) addCompound(u.name, u.fields);
  for (const fields of model.uniqueFields) addCompound(null, fields);
  if (model.primaryKey) addCompound(model.primaryKey.name, model.primaryKey.fields);
  for (const f of columns.values()) if (f.isId || f.isUnique) sets.push([f.name]);
  return {
    name: model.name,
    columns,
    compound,
    uniqueSets: sets,
    relations: relationsOf(model, all),
  };
}

const MODELS = new Map(
  Prisma.dmmf.datamodel.models.map((m) => [
    lowerFirst(m.name),
    buildModelInfo(m, Prisma.dmmf.datamodel.models),
  ]),
);

function infoFor(modelName: string): ModelInfo {
  const info = MODELS.get(modelName);
  if (!info) throw new Error(`fake-db: unknown model "${modelName}"`);
  return info;
}

function column(info: ModelInfo, name: string, where: string): Field {
  const f = info.columns.get(name);
  if (!f) throw new Error(`fake-db: ${info.name}.${name} is not a column (${where})`);
  return f;
}

// ─── where evaluation (SQL semantics) ───────────────────────────────────────

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);

const cmp = (v: unknown): number | string | boolean =>
  v instanceof Date ? v.getTime() : (v as number | string | boolean);

const same = (a: unknown, b: unknown): boolean => cmp(a) === cmp(b);

/**
 * A LIKE pattern as a RegExp, as Postgres reads it: `_` is any one character,
 * `%` any run, and a backslash makes the next character literal. Prisma sends
 * `startsWith` and `contains` as LIKE '<value>%' and LIKE '%<value>%' WITHOUT
 * escaping the value (verified on Postgres 16 with Prisma 6.19, steps B2b and D2),
 * so a caller that wants a literal `%` or `_` must escape it. A value ending in
 * a lone backslash is an error in Postgres, and here. One dialect for both
 * operators: `anchored` is the only difference. Case-sensitive like LIKE, unless
 * the filter's `mode` is "insensitive" (ILIKE).
 */
function likePattern(value: string, anchored: boolean, insensitive: boolean): RegExp {
  const literal = (c: string): string => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const chars = [...value];
  let body = "";
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i] as string;
    if (c === "\\") {
      const next = chars[i + 1];
      if (next === undefined)
        throw new Error("fake-db: LIKE pattern must not end with escape character");
      body += literal(next);
      i += 1;
    } else {
      body += c === "_" ? "." : c === "%" ? ".*" : literal(c);
    }
  }
  return new RegExp(anchored ? `^${body}` : body, insensitive ? "siu" : "su");
}

/** One operator object against one value. NULL never satisfies any operator (SQL), except `not: null`. */
function matchesOperators(actual: unknown, ops: Record<string, unknown>, where: string): boolean {
  const insensitive = ops.mode === "insensitive";
  return Object.entries(ops).every(([op, expected]) => {
    if (expected === undefined) return true;
    if (op === "mode") return expected === "insensitive" || expected === "default";
    if (op === "not" && expected === null) return actual != null;
    if (actual == null) return false;
    switch (op) {
      case "equals":
        return same(actual, expected);
      case "not":
        return isPlain(expected)
          ? !matchesOperators(actual, expected, where)
          : !same(actual, expected);
      case "in":
        return (expected as unknown[]).some((e) => same(actual, e));
      case "notIn":
        return !(expected as unknown[]).some((e) => same(actual, e));
      case "startsWith":
        return (
          typeof actual === "string" &&
          likePattern(expected as string, true, insensitive).test(actual)
        );
      case "contains":
        return (
          typeof actual === "string" &&
          likePattern(expected as string, false, insensitive).test(actual)
        );
      case "gte":
        return cmp(actual) >= cmp(expected);
      case "gt":
        return cmp(actual) > cmp(expected);
      case "lte":
        return cmp(actual) <= cmp(expected);
      case "lt":
        return cmp(actual) < cmp(expected);
      default:
        throw new Error(`fake-db: unsupported where operator "${op}" (${where})`);
    }
  });
}

function matchesField(info: ModelInfo, row: Row, name: string, cond: unknown): boolean {
  const field = column(info, name, "where");
  const actual = row[name];
  if (cond === null) {
    if (field.isRequired) {
      throw new Error(`fake-db: ${info.name}.${name} is required; a null filter is invalid`);
    }
    return actual == null;
  }
  if (isPlain(cond)) return matchesOperators(actual, cond, `${info.name}.${name}`);
  if (actual == null) return false;
  return same(actual, cond);
}

/** The live rows of another model, for a relation filter. */
type RowsOf = (model: string) => Row[];

/** `{ is: where }` / `{ isNot: where }` on a relation: does a related row match? */
function matchesRelation(rel: Relation, row: Row, cond: unknown, rowsOf: RowsOf): boolean {
  const ops = cond as Record<string, unknown>;
  const keys = isPlain(cond) ? Object.keys(ops) : [];
  if (keys.length !== 1 || !["is", "isNot"].includes(keys[0] ?? "")) {
    throw new Error(`fake-db: relation filter supports only { is } or { isNot }, got ${keys}`);
  }
  const target = infoFor(rel.target);
  const related = rowsOf(rel.target).filter((other) =>
    rel.ownKeys.every((k, i) => row[k] != null && same(row[k], other[rel.otherKeys[i] ?? ""])),
  );
  const hit = related.some((other) =>
    matchesWhere(target, other, ops[keys[0] ?? ""] as Where, rowsOf),
  );
  return keys[0] === "is" ? hit : !hit;
}

function matchesWhere(
  info: ModelInfo,
  row: Row,
  where: Where | undefined,
  rowsOf: RowsOf = () => [],
): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    if (key === "AND") return (cond as Where[]).every((w) => matchesWhere(info, row, w, rowsOf));
    if (key === "OR") return (cond as Where[]).some((w) => matchesWhere(info, row, w, rowsOf));
    if (key === "NOT") {
      const list = Array.isArray(cond) ? (cond as Where[]) : [cond as Where];
      return !list.some((w) => matchesWhere(info, row, w, rowsOf));
    }
    const rel = info.relations.get(key);
    if (rel) return matchesRelation(rel, row, cond, rowsOf);
    const parts = info.compound.get(key);
    if (parts) {
      const sub = cond as Where;
      for (const p of Object.keys(sub)) column(info, p, `compound ${key}`);
      return matchesWhere(info, row, sub, rowsOf);
    }
    return matchesField(info, row, key, cond);
  });
}

/** A `where` that names a unique record: a unique column or a compound key. */
function assertUniqueSelector(info: ModelInfo, where: Where | undefined, op: string): void {
  const keys = Object.keys(where ?? {}).filter((k) => where?.[k] !== undefined);
  const ok = keys.some(
    (k) => info.compound.has(k) || info.uniqueSets.some((s) => s.length === 1 && s[0] === k),
  );
  if (!ok) throw new Error(`fake-db: ${info.name}.${op} needs a unique selector, got ${keys}`);
}

// ─── groupBy helpers ────────────────────────────────────────────────────────

function minFieldsOf(info: ModelInfo, spec: unknown): string[] {
  if (spec === undefined) return [];
  if (!isPlain(spec)) throw new Error("fake-db: groupBy _min must be an object");
  return Object.entries(spec).map(([f, on]) => {
    column(info, f, "groupBy._min");
    if (on !== true) throw new Error(`fake-db: groupBy _min.${f} must be true`);
    return f;
  });
}

/** The smallest non-null value (SQL MIN), or null. */
function smallest(values: unknown[]): unknown {
  const present = values.filter((v) => v != null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => (cmp(b) < cmp(a) ? b : a));
}

/** orderBy on a group: `{ _min: { f: dir } }` or a `by` field `{ f: dir }`. */
function sortGroups(groups: Row[], orderBy: unknown): Row[] {
  if (orderBy === undefined) return groups;
  if (!isPlain(orderBy) || Object.keys(orderBy).length !== 1) {
    throw new Error("fake-db: groupBy orderBy supports one key");
  }
  const [key, spec] = Object.entries(orderBy)[0] ?? [];
  const pick = (g: Row): unknown =>
    key === "_min" && isPlain(spec) ? (g._min as Row)[Object.keys(spec)[0] ?? ""] : g[key ?? ""];
  const dir = key === "_min" && isPlain(spec) ? Object.values(spec)[0] : spec;
  const sign = dir === "desc" ? -1 : 1;
  return [...groups].sort((a, b) => {
    const x = cmp(pick(a));
    const y = cmp(pick(b));
    return x < y ? -sign : x > y ? sign : 0;
  });
}

// ─── rows, defaults, validation ─────────────────────────────────────────────

let idSeq = 0;

function defaultFor(f: Field): unknown {
  const d = f.default;
  if (d === undefined) return null;
  if (isPlain(d) && typeof d.name === "string") {
    if (d.name === "now") return new Date();
    if (d.name === "uuid" || d.name === "cuid") return `fake-${f.name}-${++idSeq}`;
    if (d.name === "autoincrement") return ++idSeq;
    return null;
  }
  return d;
}

function assertValue(info: ModelInfo, f: Field, value: unknown): void {
  if (value === null && f.isRequired) {
    throw new Error(`fake-db: ${info.name}.${f.name} is required and cannot be null`);
  }
  if (isPlain(value) && f.type !== "Json") {
    throw new Error(`fake-db: ${info.name}.${f.name}: operator/object writes are not supported`);
  }
}

/**
 * Prisma's atomic `{ increment: n }` on an Int column, resolved against the row
 * it updates. Anything else that is an object is left for `checkedData` to refuse.
 */
function resolveIncrements(info: ModelInfo, target: Row, data: Row): Row {
  const out: Row = { ...data };
  for (const [k, v] of Object.entries(data)) {
    if (!isPlain(v) || Object.keys(v).join() !== "increment") continue;
    const f = column(info, k, "update");
    if (f.type !== "Int" || typeof v.increment !== "number") continue;
    out[k] = ((target[k] as number | null) ?? 0) + v.increment;
  }
  return out;
}

/** Validate `data` keys and values; undefined is dropped (Prisma ignores it). */
function checkedData(info: ModelInfo, data: Row, where: string): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    const f = column(info, k, where);
    assertValue(info, f, v);
    out[k] = v;
  }
  return out;
}

/** A complete row: every column present, undefined coerced to NULL, defaults applied. */
function completeRow(info: ModelInfo, data: Row, enforceRequired: boolean): Row {
  const row: Row = {};
  for (const f of info.columns.values()) {
    const given = data[f.name];
    let v: unknown = given === undefined ? null : given;
    if (v === null && f.hasDefaultValue) v = defaultFor(f);
    if (v === null && f.isUpdatedAt) v = new Date();
    if (enforceRequired && v === null && f.isRequired) {
      throw new Error(`fake-db: ${info.name}.${f.name} is required but was not provided`);
    }
    row[f.name] = v;
  }
  return row;
}

function touchUpdatedAt(info: ModelInfo, row: Row, data: Row): void {
  for (const f of info.columns.values()) {
    if (f.isUpdatedAt && !(f.name in data)) row[f.name] = new Date();
  }
}

function project(info: ModelInfo, row: Row, select: Select | undefined): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [k, on] of Object.entries(select)) {
    column(info, k, "select");
    if (on !== true && on !== false) throw new Error(`fake-db: select.${k} must be a boolean`);
    if (on) out[k] = row[k];
  }
  return out;
}

interface SortKey {
  field: string;
  sign: 1 | -1;
  nullsFirst: boolean;
}

/**
 * One orderBy entry: "asc" | "desc", or Prisma's `{ sort, nulls }`. Postgres sorts
 * NULL as larger than any value (last ascending, first descending) unless `nulls`
 * says otherwise.
 */
function sortKeyOf(field: string, dir: unknown): SortKey {
  if (dir === "asc" || dir === "desc") {
    return { field, sign: dir === "desc" ? -1 : 1, nullsFirst: dir === "desc" };
  }
  if (isPlain(dir)) {
    const { sort, nulls, ...rest } = dir;
    const sorted = sort === "asc" || sort === "desc";
    if (sorted && (nulls === "first" || nulls === "last") && Object.keys(rest).length === 0) {
      return { field, sign: sort === "desc" ? -1 : 1, nullsFirst: nulls === "first" };
    }
  }
  throw new Error(`fake-db: orderBy ${field}: ${JSON.stringify(dir)}`);
}

function sortRows(info: ModelInfo, rows: Row[], orderBy: unknown): Row[] {
  if (orderBy === undefined) return rows;
  const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, unknown>>;
  const keys = specs.flatMap((spec) => {
    return Object.entries(spec).map(([field, dir]) => {
      column(info, field, "orderBy");
      return sortKeyOf(field, dir);
    });
  });
  return [...rows].sort((a, b) => {
    for (const { field, sign, nullsFirst } of keys) {
      const aNull = a[field] == null;
      const bNull = b[field] == null;
      if (aNull !== bNull) return aNull === nullsFirst ? -1 : 1;
      if (aNull) continue;
      const x = cmp(a[field]) as number | string;
      const y = cmp(b[field]) as number | string;
      if (x !== y) return x < y ? -sign : sign;
    }
    return 0;
  });
}

function assertArgs(model: string, op: string, args: object, allowed: readonly string[]): void {
  for (const k of Object.keys(args)) {
    if (!allowed.includes(k)) throw new Error(`fake-db: ${model}.${op} does not support "${k}"`);
  }
}

// ─── the database ───────────────────────────────────────────────────────────

/** A BigInt column sums to a BigInt (as Prisma answers), anything else to a number. */
function sumOf(values: unknown[]): bigint | number {
  if (values.every((v) => typeof v === "bigint")) {
    return (values as bigint[]).reduce((sum, v) => sum + v, 0n);
  }
  return values.reduce<number>((sum, v) => sum + Number(v), 0);
}

export interface WriteLog {
  op: string;
  where?: Where;
  data?: Row;
  update?: Row;
}

export interface FakeModel {
  findFirst(args?: Args): Promise<Row | null>;
  findUnique(args: Args): Promise<Row | null>;
  findMany(args?: Args): Promise<Row[]>;
  count(args?: Args): Promise<number>;
  groupBy(args: Args): Promise<Array<Row & { _count?: { _all: number }; _min?: Row }>>;
  aggregate(args: Args): Promise<{ _sum: Row }>;
  create(args: { data: Row; select?: Select }): Promise<Row>;
  update(args: { where: Where; data: Row; select?: Select }): Promise<Row>;
  updateMany(args: { where?: Where; data: Row }): Promise<{ count: number }>;
  deleteMany(args?: { where?: Where }): Promise<{ count: number }>;
  upsert(args: { where: Where; create: Row; update: Row; select?: Select }): Promise<Row>;
}

interface Args {
  where?: Where;
  select?: Select;
  orderBy?: unknown;
  take?: number;
  skip?: number;
  by?: string[];
  _count?: unknown;
  _sum?: unknown;
  _min?: unknown;
}

export interface FakeDb {
  /** Live rows per model. Tests may seed and inspect. */
  tables: Record<string, Row[]>;
  /** Every write issued, per model. */
  writes: Record<string, WriteLog[]>;
  /** Model name of every read issued, in order. */
  reads: string[];
  model(name: string): FakeModel;
}

export interface FakeDbHooks {
  /** Runs at the start of every updateMany, BEFORE its `where` is matched. */
  beforeUpdateMany?: (model: string, where: Where | undefined) => void;
  /** Runs at the start of every raw statement, BEFORE it is emulated; may throw. */
  beforeExecuteRaw?: () => void;
}

export function createFakeDb(seed: Record<string, Row[]>, hooks: FakeDbHooks = {}): FakeDb {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) {
    const info = infoFor(name);
    tables[name] = rows.map((r) => completeRow(info, checkedData(info, r, "seed"), false));
  }
  const writes: FakeDb["writes"] = {};
  const reads: string[] = [];
  const log = (model: string, entry: WriteLog) => {
    writes[model] = [...(writes[model] ?? []), entry];
  };

  const build = (name: string): FakeModel => {
    const info = infoFor(name);
    const rowsOf = () => {
      tables[name] ??= [];
      return tables[name];
    };
    const otherRows: RowsOf = (model) => tables[model] ?? [];
    const find = (where: Where | undefined) =>
      rowsOf().filter((r) => matchesWhere(info, r, where, otherRows));
    const page = (rows: Row[], args: Args) => {
      const sorted = sortRows(info, rows, args.orderBy);
      const from = args.skip ?? 0;
      return args.take === undefined ? sorted.slice(from) : sorted.slice(from, from + args.take);
    };
    const assertUnique = (candidate: Row, ignore?: Row) => {
      for (const set of info.uniqueSets) {
        const clash = rowsOf().some(
          (r) => r !== ignore && set.every((c) => candidate[c] != null && same(r[c], candidate[c])),
        );
        if (clash) throw new Error(`fake-db: unique constraint on ${name}(${set.join(", ")})`);
      }
    };
    const insert = (data: Row, select?: Select): Row => {
      const row = completeRow(info, checkedData(info, data, "create"), true);
      assertUnique(row);
      tables[name] = [...rowsOf(), row];
      return project(info, row, select);
    };
    const apply = (target: Row, data: Row): void => {
      const clean = checkedData(info, resolveIncrements(info, target, data), "update");
      Object.assign(target, clean);
      touchUpdatedAt(info, target, clean);
    };

    return {
      async findFirst(args = {}) {
        assertArgs(name, "findFirst", args, ["where", "select", "orderBy", "skip"]);
        reads.push(name);
        const hit = page(find(args.where), { ...args, take: 1 })[0];
        return hit ? project(info, hit, args.select) : null;
      },
      async findUnique(args) {
        assertArgs(name, "findUnique", args, ["where", "select"]);
        assertUniqueSelector(info, args.where, "findUnique");
        reads.push(name);
        const hit = find(args.where)[0];
        return hit ? project(info, hit, args.select) : null;
      },
      async findMany(args = {}) {
        assertArgs(name, "findMany", args, ["where", "select", "orderBy", "take", "skip"]);
        reads.push(name);
        return page(find(args.where), args).map((r) => project(info, r, args.select));
      },
      async count(args = {}) {
        assertArgs(name, "count", args, ["where"]);
        reads.push(name);
        return find(args.where).length;
      },
      async groupBy(args) {
        assertArgs(name, "groupBy", args, ["by", "where", "_count", "_min", "orderBy", "take"]);
        const by = args.by ?? [];
        for (const f of by) column(info, f, "groupBy.by");
        const counts = args._count as Record<string, unknown> | undefined;
        const mins = minFieldsOf(info, args._min);
        if (counts && Object.keys(counts).join() !== "_all") {
          throw new Error("fake-db: groupBy supports only _count: { _all: true }");
        }
        if (!counts && mins.length === 0) throw new Error("fake-db: groupBy needs _count or _min");
        reads.push(name);
        const groups = new Map<string, { values: unknown[]; rows: Row[] }>();
        for (const r of find(args.where)) {
          const values = by.map((f) => r[f]);
          const key = JSON.stringify(values);
          const group = groups.get(key) ?? { values, rows: [] };
          group.rows.push(r);
          groups.set(key, group);
        }
        const out = [...groups.values()].map(({ values, rows }) => ({
          ...Object.fromEntries(by.map((f, i) => [f, values[i]])),
          ...(counts && { _count: { _all: rows.length } }),
          ...(mins.length > 0 && {
            _min: Object.fromEntries(mins.map((f) => [f, smallest(rows.map((r) => r[f]))])),
          }),
        }));
        const sorted = sortGroups(out, args.orderBy);
        return args.take === undefined ? sorted : sorted.slice(0, args.take);
      },
      async aggregate(args) {
        assertArgs(name, "aggregate", args, ["where", "_sum"]);
        const sums = args._sum as Record<string, unknown> | undefined;
        if (!sums || Object.values(sums).some((v) => v !== true)) {
          throw new Error("fake-db: aggregate supports only _sum: { <field>: true }");
        }
        reads.push(name);
        const rows = find(args.where);
        const _sum: Row = {};
        for (const field of Object.keys(sums)) {
          column(info, field, "aggregate._sum");
          // Like Postgres SUM: NULLs are skipped, and no value at all is NULL.
          const values = rows.map((r) => r[field]).filter((v) => v !== null && v !== undefined);
          _sum[field] = values.length === 0 ? null : sumOf(values);
        }
        return { _sum };
      },
      async create(args) {
        assertArgs(name, "create", args, ["data", "select"]);
        log(name, { op: "create", data: args.data });
        return insert(args.data, args.select);
      },
      async update(args) {
        assertArgs(name, "update", args, ["where", "data", "select"]);
        assertUniqueSelector(info, args.where, "update");
        log(name, { op: "update", where: args.where, data: args.data });
        const target = find(args.where)[0];
        if (!target) throw new Error(`fake-db: ${name}.update matched no row`);
        apply(target, args.data);
        return project(info, target, args.select);
      },
      async updateMany(args) {
        assertArgs(name, "updateMany", args, ["where", "data"]);
        log(name, { op: "updateMany", where: args.where, data: args.data });
        hooks.beforeUpdateMany?.(name, args.where);
        const targets = find(args.where);
        for (const r of targets) apply(r, args.data);
        return { count: targets.length };
      },
      async deleteMany(args = {}) {
        assertArgs(name, "deleteMany", args, ["where"]);
        log(name, { op: "deleteMany", where: args.where });
        const doomed = new Set(find(args.where));
        tables[name] = rowsOf().filter((r) => !doomed.has(r));
        return { count: doomed.size };
      },
      async upsert(args) {
        assertArgs(name, "upsert", args, ["where", "create", "update", "select"]);
        assertUniqueSelector(info, args.where, "upsert");
        log(name, { op: "upsert", where: args.where, data: args.create, update: args.update });
        const target = find(args.where)[0];
        if (!target) return insert(args.create, args.select);
        apply(target, args.update);
        return project(info, target, args.select);
      },
    };
  };

  const cache = new Map<string, FakeModel>();
  return {
    tables,
    writes,
    reads,
    model(name) {
      const existing = cache.get(name);
      if (existing) return existing;
      const created = build(name);
      cache.set(name, created);
      return created;
    },
  };
}

export interface FakeClientOptions {
  /**
   * An interactive `$transaction` that throws restores every table to what it was
   * when the transaction began, like a real rollback. Off by default: existing tests
   * were written against "operations run as they are issued". Not isolation: a
   * concurrent writer's changes made meanwhile are rolled back with it.
   */
  rollbackOnError?: boolean;
}

/**
 * The one raw statement the code under test may issue: the B2b re-key of
 * mail/imap-tombstone.ts. The fake owns its own copy of the SQL text on purpose: a
 * change to the production statement (a dropped clause, another operator) no longer
 * matches and throws, so the tests fail instead of emulating the old semantics.
 * Whitespace is normalised; parameters are `$n`, in this order: suffix, now, userId,
 * prefix, pattern (a POSIX regex for `!~`, emulated with a JavaScript RegExp: the
 * tombstone pattern means the same in both).
 */
const REKEY_SQL =
  'UPDATE "EmailMessage" SET "gmailId" = "gmailId" || $1::text, "updatedAt" = $2 ' +
  'WHERE "userId" = $3 AND starts_with("gmailId", $4::text) AND "gmailId" !~ $5::text';

const normalisedSql = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Applies the re-key with the semantics the SQL has, one unique key checked first. */
async function executeRaw(db: FakeDb, hooks: FakeDbHooks, statement: unknown): Promise<number> {
  hooks.beforeExecuteRaw?.();
  const given = statement as { text?: string; values?: unknown[] };
  if (
    typeof given.text !== "string" ||
    normalisedSql(given.text) !== REKEY_SQL ||
    !Array.isArray(given.values)
  ) {
    throw new Error(`fake-db: unsupported raw statement: ${String(given.text)}`);
  }
  const [suffix, now, userId, prefix, pattern] = given.values as [
    string,
    Date,
    string,
    string,
    string,
  ];
  const skip = new RegExp(pattern);
  const rows = db.tables.emailMessage ?? [];
  const targets = rows.filter(
    (r) =>
      r.userId === userId &&
      typeof r.gmailId === "string" &&
      r.gmailId.startsWith(prefix) &&
      !skip.test(r.gmailId),
  );
  for (const r of targets) {
    const next = `${r.gmailId as string}${suffix}`;
    const clash = rows.some((o) => o !== r && o.userId === userId && o.gmailId === next);
    // Worded like Postgres (23505), which quotes the colliding key.
    if (clash) throw new Error(`Key ("userId", "gmailId")=(${userId}, ${next}) already exists.`);
  }
  db.writes.$executeRaw = [
    ...(db.writes.$executeRaw ?? []),
    { op: "executeRaw", data: { userId, prefix, suffix, count: targets.length } },
  ];
  for (const r of targets) {
    r.gmailId = `${r.gmailId as string}${suffix}`;
    r.updatedAt = now;
  }
  return targets.length;
}

/**
 * A Prisma-client stand-in for `vi.mock("../db.js")`: model accessors plus
 * `$transaction`, in both Prisma forms (batch array of operations, interactive
 * callback), and `$executeRaw` for the statements `executeRaw` knows. Operations run
 * as they are issued, so this simulates the batch's ordering and failure
 * propagation, not isolation; rollback only with `rollbackOnError`.
 */
export function fakePrismaClient(
  getDb: () => FakeDb,
  options: FakeClientOptions = {},
  hooks: FakeDbHooks = {},
): unknown {
  const client: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        if (prop === "$executeRaw") {
          return (statement: unknown) => executeRaw(getDb(), hooks, statement);
        }
        if (prop === "$transaction") {
          return async (arg: unknown) => {
            if (Array.isArray(arg)) return Promise.all(arg);
            const run = arg as (tx: unknown) => unknown;
            if (!options.rollbackOnError) return run(client);
            const db = getDb();
            const before = structuredClone(db.tables);
            try {
              return await run(client);
            } catch (err) {
              for (const name of Object.keys(db.tables)) delete db.tables[name];
              Object.assign(db.tables, before);
              throw err;
            }
          };
        }
        return MODELS.has(prop) ? getDb().model(prop) : undefined;
      },
    },
  );
  return client;
}
