/**
 * The interaction graph adds a bonus for upcoming meetings, counted from
 * CalendarEvent. While LINKED_CALENDAR_SYNC_ENABLED is off it must count primary
 * and LOCAL rows only (C2 kill switch).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ countWheres: [] as Array<Record<string, unknown>> }));

vi.mock("../db.js", () => {
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) =>
          vi.fn(async (args?: { where?: Record<string, unknown> }) => {
            if (name === "calendarEvent" && method === "count")
              m.countWheres.push(args?.where ?? {});
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
});
