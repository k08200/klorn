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
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

function buildModelInfo(model: (typeof Prisma.dmmf.datamodel.models)[number]): ModelInfo {
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
  return { name: model.name, columns, compound, uniqueSets: sets };
}

const MODELS = new Map(
  Prisma.dmmf.datamodel.models.map((m) => [lowerFirst(m.name), buildModelInfo(m)]),
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

/** One operator object against one value. NULL never satisfies any operator (SQL), except `not: null`. */
function matchesOperators(actual: unknown, ops: Record<string, unknown>, where: string): boolean {
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
        return typeof actual === "string" && actual.startsWith(expected as string);
      case "contains":
        return (
          typeof actual === "string" &&
          actual.toLowerCase().includes((expected as string).toLowerCase())
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

function matchesWhere(info: ModelInfo, row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    if (key === "AND") return (cond as Where[]).every((w) => matchesWhere(info, row, w));
    if (key === "OR") return (cond as Where[]).some((w) => matchesWhere(info, row, w));
    if (key === "NOT") {
      const list = Array.isArray(cond) ? (cond as Where[]) : [cond as Where];
      return !list.some((w) => matchesWhere(info, row, w));
    }
    const parts = info.compound.get(key);
    if (parts) {
      const sub = cond as Where;
      for (const p of Object.keys(sub)) column(info, p, `compound ${key}`);
      return matchesWhere(info, row, sub);
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

function sortRows(info: ModelInfo, rows: Row[], orderBy: unknown): Row[] {
  if (orderBy === undefined) return rows;
  const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, unknown>>;
  const keys = specs.flatMap((spec) => {
    return Object.entries(spec).map(([field, dir]) => {
      column(info, field, "orderBy");
      if (dir !== "asc" && dir !== "desc") throw new Error(`fake-db: orderBy ${field}: ${dir}`);
      return { field, sign: dir === "desc" ? -1 : 1 };
    });
  });
  // Postgres sorts NULL as larger than any value.
  const rank = (v: unknown) => (v == null ? Number.POSITIVE_INFINITY : cmp(v));
  return [...rows].sort((a, b) => {
    for (const { field, sign } of keys) {
      const x = rank(a[field]) as number | string;
      const y = rank(b[field]) as number | string;
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
  groupBy(args: Args): Promise<Array<Row & { _count: { _all: number } }>>;
  create(args: { data: Row; select?: Select }): Promise<Row>;
  update(args: { where: Where; data: Row; select?: Select }): Promise<Row>;
  updateMany(args: { where?: Where; data: Row }): Promise<{ count: number }>;
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
    const find = (where: Where | undefined) => rowsOf().filter((r) => matchesWhere(info, r, where));
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
      const clean = checkedData(info, data, "update");
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
        assertArgs(name, "groupBy", args, ["by", "where", "_count"]);
        const by = args.by ?? [];
        for (const f of by) column(info, f, "groupBy.by");
        const counts = args._count as Record<string, unknown> | undefined;
        if (!counts || Object.keys(counts).join() !== "_all") {
          throw new Error("fake-db: groupBy supports only _count: { _all: true }");
        }
        reads.push(name);
        const groups = new Map<string, { values: unknown[]; n: number }>();
        for (const r of find(args.where)) {
          const values = by.map((f) => r[f]);
          const key = JSON.stringify(values);
          groups.set(key, { values, n: (groups.get(key)?.n ?? 0) + 1 });
        }
        return [...groups.values()].map(({ values, n }) => ({
          ...Object.fromEntries(by.map((f, i) => [f, values[i]])),
          _count: { _all: n },
        }));
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

/**
 * A Prisma-client stand-in for `vi.mock("../db.js")`: model accessors plus
 * `$transaction`, in both Prisma forms (batch array of operations, interactive
 * callback). Operations run as they are issued, so this simulates the batch's
 * ordering and failure propagation, not isolation or rollback.
 */
export function fakePrismaClient(getDb: () => FakeDb): unknown {
  const client: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        if (prop === "$transaction") {
          return async (arg: unknown) =>
            Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(client);
        }
        return MODELS.has(prop) ? getDb().model(prop) : undefined;
      },
    },
  );
  return client;
}
