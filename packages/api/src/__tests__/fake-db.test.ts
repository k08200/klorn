/**
 * The in-memory database the tier tests rely on must behave like Prisma where it
 * matters, or a wrong query passes. Each case below is a place a lenient fake
 * diverges from the real client (found by probing it); the strict fake must
 * throw or follow SQL semantics instead.
 */

import { describe, expect, it, vi } from "vitest";
import { createFakeDb, fakePrismaClient, type Row } from "./helpers/fake-db.js";

const item = (over: Row = {}): Row => ({
  id: "a",
  userId: "u1",
  source: "EMAIL",
  sourceId: "s1",
  type: "REPLY_NEEDED",
  title: "t",
  tier: "QUEUE",
  isManualOverride: false,
  agentTierSetAt: null,
  ...over,
});

const db = (rows: Row[] = [item()]) => createFakeDb({ attentionItem: rows });
const items = (d = db()) => d.model("attentionItem");

describe("schema checking", () => {
  it("throws on an unknown field in where, data, select and orderBy", async () => {
    const m = items();
    await expect(m.findMany({ where: { tierr: "QUEUE" } })).rejects.toThrow(
      /tierr is not a column/,
    );
    await expect(m.updateMany({ where: {}, data: { nope: 1 } })).rejects.toThrow(/nope/);
    await expect(m.findMany({ select: { nope: true } })).rejects.toThrow(/nope/);
    await expect(m.findMany({ orderBy: { nope: "asc" } })).rejects.toThrow(/nope/);
  });

  it("throws on a relation field (it is not a column) and on an unknown seeded key or table", () => {
    expect(() => createFakeDb({ attentionItem: [item({ user: {} })] })).toThrow(/user/);
    expect(() => createFakeDb({ attentionItem: [item({ bogus: 1 })] })).toThrow(/bogus/);
    expect(() => createFakeDb({ noSuchModel: [] })).toThrow(/unknown model/);
  });

  it("throws on an argument or operator it does not implement instead of ignoring it", async () => {
    const m = items();
    await expect(m.findMany({ distinct: ["tier"] } as never)).rejects.toThrow(/distinct/);
    await expect(m.findMany({ where: { tier: { search: "x" } } })).rejects.toThrow(/operator/);
    await expect(m.updateMany({ where: {}, data: { priority: { increment: 1 } } })).rejects.toThrow(
      /operator\/object/,
    );
  });
});

describe("SQL NULL semantics", () => {
  const rows = [item({ id: "n", sourceId: "n", tier: null }), item({ id: "q", sourceId: "q" })];

  it("`{ not: 'X' }` does not match a NULL row", async () => {
    const got = await items(db(rows)).findMany({ where: { tier: { not: "X" } } });
    expect(got.map((r) => r.id)).toEqual(["q"]);
  });

  it("a missing key is NULL: it satisfies `{x: null}` and never `{x: {not: null}}`", async () => {
    const d = createFakeDb({
      attentionItem: [{ id: "m", userId: "u1", source: "EMAIL", sourceId: "m" }],
    });
    expect(
      await d.model("attentionItem").findMany({ where: { agentTierSetAt: null } }),
    ).toHaveLength(1);
    expect(
      await d.model("attentionItem").findMany({ where: { agentTierSetAt: { not: null } } }),
    ).toHaveLength(0);
  });

  it("`in`, comparisons and equality never match NULL", async () => {
    const m = items(db(rows));
    expect(await m.findMany({ where: { tier: { in: ["QUEUE", "PUSH"] } } })).toHaveLength(1);
    expect(await m.findMany({ where: { tier: "QUEUE" } })).toHaveLength(1);
    expect(await m.findMany({ where: { tier: { notIn: ["X"] } } })).toHaveLength(1);
  });

  it("a null filter on a required column is invalid, as in Prisma", async () => {
    await expect(items().findMany({ where: { isManualOverride: null } })).rejects.toThrow(
      /required/,
    );
  });

  it("applies @default values to seeded rows (an omitted boolean is its default, not NULL)", async () => {
    const d = createFakeDb({
      attentionItem: [{ id: "d", userId: "u1", source: "EMAIL", sourceId: "d" }],
    });
    const [row] = await d.model("attentionItem").findMany({ where: { isManualOverride: false } });
    expect(row).toMatchObject({ status: "OPEN", priority: 50, autoEligible: false });
  });
});

describe("`contains` and `startsWith` are one LIKE dialect, as Prisma sends them to Postgres", () => {
  const titled = (title: string) => item({ id: title, sourceId: title, title });
  const rows = ["100% done", "100 percent", "a_b", "axb", "back\\slash", "Q3 Report"].map(titled);
  const ids = (found: Array<{ id?: unknown }>) => found.map((r) => r.id).sort();
  const find = async (contains: string, mode?: "insensitive" | "default") =>
    ids(await items(db(rows)).findMany({ where: { title: { contains, mode } } }));
  const prefixed = async (startsWith: string, mode?: "insensitive" | "default") =>
    ids(await items(db(rows)).findMany({ where: { title: { startsWith, mode } } }));

  it("an unescaped % or _ is a wildcard, in both", async () => {
    expect(await find("100%")).toEqual(["100 percent", "100% done"]);
    expect(await find("a_b")).toEqual(["a_b", "axb"]);
    expect(await prefixed("100%d")).toEqual(["100% done"]);
    expect(await prefixed("a_b")).toEqual(["a_b", "axb"]);
  });

  it("a backslash makes the next character literal, in both", async () => {
    expect(await find("100\\%")).toEqual(["100% done"]);
    expect(await find("a\\_b")).toEqual(["a_b"]);
    expect(await find("back\\\\slash")).toEqual(["back\\slash"]);
    expect(await prefixed("100\\%")).toEqual(["100% done"]);
    expect(await prefixed("a\\_b")).toEqual(["a_b"]);
    expect(await prefixed("back\\\\s")).toEqual(["back\\slash"]);
  });

  it("`contains` matches anywhere, `startsWith` only at the start; regex characters are literal", async () => {
    expect(await find("Report")).toEqual(["Q3 Report"]);
    expect(await prefixed("Report")).toEqual([]);
    expect(await prefixed("Q3")).toEqual(["Q3 Report"]);
    expect(await find(".*")).toEqual([]);
    expect(await prefixed(".*")).toEqual([]);
  });

  it("is case-sensitive, as LIKE is, unless the mode is insensitive (ILIKE)", async () => {
    expect(await find("report")).toEqual([]);
    expect(await find("report", "default")).toEqual([]);
    expect(await find("report", "insensitive")).toEqual(["Q3 Report"]);
    expect(await prefixed("q3")).toEqual([]);
    expect(await prefixed("q3", "insensitive")).toEqual(["Q3 Report"]);
  });

  it("a pattern ending in a lone backslash throws, as Postgres does, in both", async () => {
    await expect(find("oops\\")).rejects.toThrow(/must not end with escape character/);
    await expect(prefixed("oops\\")).rejects.toThrow(/must not end with escape character/);
  });
});

describe("upsert", () => {
  const where = { userId_source_sourceId: { userId: "u1", source: "EMAIL", sourceId: "s1" } };
  const create = {
    userId: "u1",
    source: "EMAIL",
    sourceId: "s1",
    type: "REPLY_NEEDED",
    title: "new",
  };

  it("evaluates its where: an existing row is UPDATED, not duplicated", async () => {
    const d = db();
    await d.model("attentionItem").upsert({ where, create, update: { title: "changed" } });
    expect(d.tables.attentionItem).toHaveLength(1);
    expect(d.tables.attentionItem[0].title).toBe("changed");
  });

  it("creates when nothing matches, applying defaults", async () => {
    const d = db([]);
    const made = await d.model("attentionItem").upsert({ where, create, update: { title: "x" } });
    expect(d.tables.attentionItem).toHaveLength(1);
    expect(made).toMatchObject({ title: "new", status: "OPEN", isManualOverride: false });
    expect(made.id).toEqual(expect.any(String));
  });

  it("needs a unique selector", async () => {
    await expect(items().upsert({ where: { tier: "QUEUE" }, create, update: {} })).rejects.toThrow(
      /unique selector/,
    );
  });
});

describe("create, update and ordering", () => {
  it("create enforces required columns and unique keys", async () => {
    const d = db();
    await expect(d.model("attentionItem").create({ data: { userId: "u1" } })).rejects.toThrow(
      /required/,
    );
    await expect(
      d.model("attentionItem").create({
        data: { userId: "u1", source: "EMAIL", sourceId: "s1", type: "REPLY_NEEDED", title: "dup" },
      }),
    ).rejects.toThrow(/unique constraint/);
  });

  it("models @updatedAt on update and updateMany, unless the write sets it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
    const d = db([item({ updatedAt: new Date("2026-01-01T00:00:00.000Z") })]);
    await d.model("attentionItem").updateMany({ where: { id: "a" }, data: { tier: "PUSH" } });
    expect(d.tables.attentionItem[0].updatedAt).toEqual(new Date("2026-09-30T10:00:00.000Z"));
    const pinned = new Date("2026-02-02T00:00:00.000Z");
    await d.model("attentionItem").updateMany({ where: { id: "a" }, data: { updatedAt: pinned } });
    expect(d.tables.attentionItem[0].updatedAt).toEqual(pinned);
    vi.useRealTimers();
  });

  it("findFirst honours orderBy and skip; NULL sorts last ascending", async () => {
    const d = db([
      item({ id: "x", sourceId: "x", priority: 30 }),
      item({ id: "y", sourceId: "y", priority: 10 }),
      item({ id: "z", sourceId: "z", priority: 20 }),
    ]);
    const m = d.model("attentionItem");
    expect((await m.findFirst({ orderBy: { priority: "asc" } }))?.id).toBe("y");
    expect((await m.findFirst({ orderBy: { priority: "asc" }, skip: 1 }))?.id).toBe("z");
    expect((await m.findFirst({ orderBy: { priority: "desc" } }))?.id).toBe("x");
  });

  it("groupBy keeps NULL as null (it is not stringified) and counts per group", async () => {
    const d = db([
      item({ id: "n1", sourceId: "n1", tier: null }),
      item({ id: "n2", sourceId: "n2", tier: null }),
      item({ id: "q", sourceId: "q" }),
    ]);
    const groups = await d.model("attentionItem").groupBy({ by: ["tier"], _count: { _all: true } });
    expect(groups).toEqual(
      expect.arrayContaining([
        { tier: null, _count: { _all: 2 } },
        { tier: "QUEUE", _count: { _all: 1 } },
      ]),
    );
  });
});

describe("fakePrismaClient", () => {
  it("runs both $transaction forms and exposes models", async () => {
    const d = db();
    const client = fakePrismaClient(() => d) as {
      $transaction: (a: unknown) => Promise<unknown[]>;
      attentionItem: { updateMany: (a: unknown) => Promise<{ count: number }> };
    };
    const batch = await client.$transaction([
      client.attentionItem.updateMany({ where: { id: "a" }, data: { tier: "PUSH" } }),
    ]);
    expect(batch).toEqual([{ count: 1 }]);
    const interactive = await client.$transaction(async (tx: typeof client) =>
      tx.attentionItem.updateMany({ where: { id: "a" }, data: { tier: "INFO" } }),
    );
    expect(interactive).toEqual({ count: 1 });
    expect(d.tables.attentionItem[0].tier).toBe("INFO");
  });

  it("does not pretend to be thenable or to have arbitrary properties", () => {
    const client = fakePrismaClient(() => db()) as Record<string, unknown>;
    expect(client.then).toBeUndefined();
    expect(client.somethingElse).toBeUndefined();
  });
});
