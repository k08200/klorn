/**
 * A tiny in-memory stand-in for the Prisma models the tier-learning readers and
 * set_tier touch. It EVALUATES the `where` clause each caller builds, so a test
 * proves what a real reader would do with the rows, not just that it issued a
 * query. Covers exactly the operators those readers use; an operator it does not
 * know throws, so a new query shape fails loudly instead of silently matching.
 *
 * Every model also records its writes (`writes.<model>`), so a test can assert
 * that a code path never touched a table (e.g. the decision ledger).
 */

export type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);

const asComparable = (v: unknown): number | string =>
  v instanceof Date ? v.getTime() : (v as number | string);

const OPERATOR_KEYS = new Set([
  "not",
  "in",
  "startsWith",
  "contains",
  "mode",
  "gte",
  "gt",
  "lte",
  "lt",
]);
const hasOperatorKey = (cond: Record<string, unknown>): boolean =>
  Object.keys(cond).some((k) => OPERATOR_KEYS.has(k));

function matchesOperator(actual: unknown, op: Record<string, unknown>): boolean {
  return Object.entries(op).every(([key, expected]) => {
    switch (key) {
      case "not":
        return isObject(expected) ? !matchesOperator(actual, expected) : actual !== expected;
      case "in":
        return (expected as unknown[]).includes(actual);
      case "startsWith":
        return typeof actual === "string" && actual.startsWith(expected as string);
      case "contains":
        return (
          typeof actual === "string" &&
          actual.toLowerCase().includes((expected as string).toLowerCase())
        );
      case "mode":
        return true;
      case "gte":
        return actual != null && asComparable(actual) >= asComparable(expected);
      case "gt":
        return actual != null && asComparable(actual) > asComparable(expected);
      case "lte":
        return actual != null && asComparable(actual) <= asComparable(expected);
      case "lt":
        return actual != null && asComparable(actual) < asComparable(expected);
      default:
        throw new Error(`fake-db: unsupported where operator "${key}"`);
    }
  });
}

/** Does `row` satisfy a Prisma-style `where`? Undefined clauses are ignored, as Prisma does. */
export function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([field, cond]) => {
    if (cond === undefined) return true;
    if (field === "OR") return (cond as Where[]).some((w) => matches(row, w));
    if (field === "AND") return (cond as Where[]).every((w) => matches(row, w));
    // A compound unique key (`userId_source_sourceId: { userId, ... }`) is the
    // conjunction of its parts.
    if (isObject(cond) && field.includes("_") && !(field in row) && !hasOperatorKey(cond)) {
      return matches(row, cond);
    }
    const actual = row[field];
    if (isObject(cond)) return matchesOperator(actual, cond);
    return cond === null ? actual == null : actual === cond;
  });
}

function project(row: Row, select: Record<string, boolean> | undefined): Row {
  if (!select) return { ...row };
  return Object.fromEntries(
    Object.entries(select)
      .filter(([, on]) => on)
      .map(([k]) => [k, row[k]]),
  );
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  const spec = Array.isArray(orderBy) ? orderBy[0] : orderBy;
  if (!isObject(spec)) return rows;
  const [field, dir] = Object.entries(spec)[0] as [string, "asc" | "desc"];
  const sign = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = asComparable(a[field]);
    const y = asComparable(b[field]);
    return x === y ? 0 : x < y ? -sign : sign;
  });
}

export interface FakeModel {
  findFirst(args?: { where?: Where; select?: Record<string, boolean> }): Promise<Row | null>;
  findMany(args?: {
    where?: Where;
    select?: Record<string, boolean>;
    orderBy?: unknown;
    take?: number;
  }): Promise<Row[]>;
  updateMany(args: { where?: Where; data: Row }): Promise<{ count: number }>;
  update(args: { where: Where; data: Row }): Promise<Row>;
  create(args: { data: Row; select?: Record<string, boolean> }): Promise<Row>;
  findUnique(args?: { where?: Where; select?: Record<string, boolean> }): Promise<Row | null>;
  upsert(args: { where?: Where; create: Row; update: Row }): Promise<Row>;
  count(args?: { where?: Where }): Promise<number>;
  groupBy(args: {
    by: string[];
    where?: Where;
    _count?: unknown;
  }): Promise<Array<Row & { _count: { _all: number } }>>;
}

export interface FakeDb {
  /** Live rows per model. Tests may seed and inspect. */
  tables: Record<string, Row[]>;
  /** Every write issued, per model: `{ op, where, data }`. */
  writes: Record<string, Array<{ op: string; where?: Where; data?: Row }>>;
  /** Model name of every read issued, in order (findFirst/findMany/count/groupBy). */
  reads: string[];
  model(name: string): FakeModel;
}

/** Applied to every updateMany/update after matching, e.g. to simulate a concurrent human override. */
export interface FakeDbHooks {
  beforeUpdateMany?: (model: string, where: Where | undefined) => void;
}

export function createFakeDb(seed: Record<string, Row[]>, hooks: FakeDbHooks = {}): FakeDb {
  const tables: Record<string, Row[]> = Object.fromEntries(
    Object.entries(seed).map(([name, rows]) => [name, rows.map((r) => ({ ...r }))]),
  );
  const writes: FakeDb["writes"] = {};
  const reads: string[] = [];
  const log = (model: string, entry: { op: string; where?: Where; data?: Row }) => {
    writes[model] = [...(writes[model] ?? []), entry];
  };
  const rowsOf = (name: string) => tables[name] ?? [];

  function build(name: string): FakeModel {
    return {
      async findFirst(args = {}) {
        reads.push(name);
        const hit = rowsOf(name).find((r) => matches(r, args.where));
        return hit ? project(hit, args.select) : null;
      },
      async findMany(args = {}) {
        reads.push(name);
        const hits = sortRows(
          rowsOf(name).filter((r) => matches(r, args.where)),
          args.orderBy,
        );
        const limited = args.take === undefined ? hits : hits.slice(0, args.take);
        return limited.map((r) => project(r, args.select));
      },
      async updateMany(args) {
        log(name, { op: "updateMany", where: args.where, data: args.data });
        hooks.beforeUpdateMany?.(name, args.where);
        const targets = rowsOf(name).filter((r) => matches(r, args.where));
        for (const r of targets) Object.assign(r, args.data);
        return { count: targets.length };
      },
      async update(args) {
        log(name, { op: "update", where: args.where, data: args.data });
        const target = rowsOf(name).find((r) => matches(r, args.where));
        if (!target) throw new Error(`fake-db: ${name}.update matched no row`);
        Object.assign(target, args.data);
        return { ...target };
      },
      async count(args = {}) {
        reads.push(name);
        return rowsOf(name).filter((r) => matches(r, args.where)).length;
      },
      async create(args) {
        log(name, { op: "create", data: args.data });
        const created = {
          id: `fake-${name}-${rowsOf(name).length + 1}`,
          createdAt: new Date(),
          ...args.data,
        };
        tables[name] = [...rowsOf(name), created];
        return project(created, args.select);
      },
      async findUnique(args = {}) {
        reads.push(name);
        const hit = rowsOf(name).find((r) => matches(r, args.where));
        return hit ? project(hit, args.select) : null;
      },
      async upsert(args) {
        log(name, { op: "upsert", where: args.where, data: args.create });
        const created = { id: `fake-${name}-${rowsOf(name).length + 1}`, ...args.create };
        tables[name] = [...rowsOf(name), created];
        return { ...created };
      },
      async groupBy(args) {
        reads.push(name);
        const groups = new Map<string, number>();
        for (const r of rowsOf(name).filter((x) => matches(x, args.where))) {
          const key = args.by.map((f) => String(r[f])).join("|");
          groups.set(key, (groups.get(key) ?? 0) + 1);
        }
        return [...groups.entries()].map(([key, n]) => {
          const parts = key.split("|");
          const base = Object.fromEntries(args.by.map((f, i) => [f, parts[i]]));
          return { ...base, _count: { _all: n } };
        });
      },
    };
  }

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
