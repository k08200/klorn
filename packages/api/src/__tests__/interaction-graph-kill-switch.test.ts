/**
 * The interaction graph adds a bonus for upcoming meetings, counted from
 * CalendarEvent. While LINKED_CALENDAR_SYNC_ENABLED is off it must count primary
 * and LOCAL rows only (C2 kill switch).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  countWheres: [] as Array<Record<string, unknown>>,
  methods: [] as string[],
  rows: [] as unknown[],
}));

vi.mock("../db.js", () => {
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) =>
          vi.fn(async (args?: { where?: Record<string, unknown> }) => {
            // The meeting count is a count(), or a row read once copies can exist (C7).
            if (name === "calendarEvent" && (method === "count" || method === "findMany")) {
              m.countWheres.push(args?.where ?? {});
              m.methods.push(method);
              if (method === "findMany") return m.rows;
            }
            return method === "findMany" ? [] : method === "count" ? 0 : null;
          }),
      },
    );
  const prisma = new Proxy({}, { get: (_t, name: string) => model(name) });
  return { prisma, db: prisma };
});
vi.mock("../learning/memory.js", () => ({ remember: vi.fn(async () => {}) }));

import { buildInteractionGraph } from "../learning/interaction-graph.js";

beforeEach(() => {
  m.countWheres = [];
  m.methods = [];
  m.rows = [];
});
afterEach(() => {
  delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
});

describe("buildInteractionGraph — kill switch", () => {
  it("counts upcoming meetings from primary and LOCAL rows only while the flag is off", async () => {
    delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
    await buildInteractionGraph("u1");
    expect(m.countWheres).toHaveLength(1);
    expect(m.countWheres[0]?.sourceAccountId).toBeNull();
  });

  it("does not narrow the count once the flag is on", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    await buildInteractionGraph("u1");
    expect(m.countWheres[0]).not.toHaveProperty("sourceAccountId");
  });

  it("counts in the database while no linked row can be visible, and reads rows to merge copies once it is on (C7)", async () => {
    delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
    await buildInteractionGraph("u1");
    expect(m.methods).toEqual(["count"]);

    m.methods = [];
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    await buildInteractionGraph("u1");
    expect(m.methods).toEqual(["findMany"]);
  });
});
