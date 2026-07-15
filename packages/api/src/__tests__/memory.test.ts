import { beforeEach, describe, expect, it, vi } from "vitest";

type Mem = {
  id: string;
  userId: string;
  type: string;
  key: string;
  content: string;
  source?: string;
  updatedAt: Date;
  lastUsedAt?: Date;
  confidence?: number;
};
const store = new Map<string, Mem>();
let nextId = 1;

vi.mock("../db.js", () => {
  const memory = {
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { userId_type_key: { userId: string; type: string; key: string } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const { userId, type, key } = where.userId_type_key;
        // Find existing
        for (const [id, m] of store) {
          if (m.userId === userId && m.type === type && m.key === key) {
            const updated = { ...m, ...update, updatedAt: new Date() };
            store.set(id, updated as Mem);
            return updated;
          }
        }
        // Create new
        const id = `mem-${nextId++}`;
        const mem = { id, ...create, updatedAt: new Date() } as Mem;
        store.set(id, mem);
        return mem;
      },
    ),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const r: Mem[] = [];
      for (const m of store.values()) {
        if (m.userId === where.userId) {
          if (where.type && m.type !== where.type) continue;
          r.push(m);
        }
      }
      return r;
    }),
    updateMany: vi.fn(async () => ({ count: 1 })),
    delete: vi.fn(
      async ({
        where,
      }: {
        where: { userId_type_key: { userId: string; type: string; key: string } };
      }) => {
        const { userId, type, key } = where.userId_type_key;
        for (const [id, m] of store) {
          if (m.userId === userId && m.type === type && m.key === key) {
            store.delete(id);
            return m;
          }
        }
        throw new Error("Not found");
      },
    ),
  };
  return { prisma: { memory }, db: { memory } };
});

import { forget, loadMemoriesForPrompt, recall, remember } from "../learning/memory.js";

describe("memory functions", () => {
  beforeEach(() => {
    store.clear();
    nextId = 1;
  });

  it("remember creates a new memory", async () => {
    const result = await remember("u1", "PREFERENCE", "lang", "Korean");
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.message).toContain("lang");
    expect(store.size).toBe(1);
  });

  it("remember upserts existing memory", async () => {
    await remember("u1", "FACT", "name", "Alice");
    await remember("u1", "FACT", "name", "Bob");
    expect(store.size).toBe(1);
    const mem = [...store.values()][0];
    expect(mem.content).toBe("Bob");
  });

  it("recall returns matching memories", async () => {
    await remember("u1", "PREFERENCE", "lang", "Korean");
    await remember("u1", "FACT", "company", "Acme");
    const result = await recall("u1");
    const parsed = JSON.parse(result);
    expect(parsed.memories).toHaveLength(2);
  });

  it("recall filters by type", async () => {
    await remember("u1", "PREFERENCE", "lang", "Korean");
    await remember("u1", "FACT", "company", "Acme");
    const result = await recall("u1", undefined, "FACT");
    const parsed = JSON.parse(result);
    expect(parsed.memories).toHaveLength(1);
    expect(parsed.memories[0].type).toBe("FACT");
  });

  it("recall returns empty for no matches", async () => {
    const result = await recall("u1");
    const parsed = JSON.parse(result);
    expect(parsed.memories).toHaveLength(0);
    expect(parsed.message).toContain("No memories");
  });

  it("forget removes a memory", async () => {
    await remember("u1", "PREFERENCE", "lang", "Korean");
    const result = await forget("u1", "lang", "PREFERENCE");
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(store.size).toBe(0);
  });

  it("forget returns failure for non-existent memory", async () => {
    const result = await forget("u1", "nonexistent", "FACT");
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
  });

  it("loadMemoriesForPrompt returns formatted string", async () => {
    await remember("u1", "PREFERENCE", "lang", "Korean");
    await remember("u1", "FACT", "company", "Acme");
    const result = await loadMemoriesForPrompt("u1");
    expect(result).toContain("User Memory");
    expect(result).toContain("lang: Korean");
    expect(result).toContain("company: Acme");
  });

  it("loadMemoriesForPrompt returns empty for no memories", async () => {
    const result = await loadMemoriesForPrompt("u1");
    expect(result).toBe("");
  });
});
