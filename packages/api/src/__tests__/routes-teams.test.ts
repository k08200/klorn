/**
 * /api/teams CRUD — owner scoping, member validation, duplicate names.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; userId: string; name: string; members: string[] }>,
  nextId: 1,
}));

class P2002 extends Error {
  code = "P2002";
}

vi.mock("../auth.js", () => ({
  requireAuth: async () => {},
  getUserId: () => "user-1",
}));
vi.mock("../db.js", () => {
  const prisma = {
    team: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        state.rows.filter((r) => r.userId === where.userId),
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string } }) =>
          state.rows.find((r) => r.id === where.id && r.userId === where.userId) ?? null,
      ),
      create: vi.fn(
        async ({ data }: { data: { userId: string; name: string; members: string[] } }) => {
          if (state.rows.some((r) => r.userId === data.userId && r.name === data.name)) {
            throw new P2002("dup");
          }
          const row = { id: `t-${state.nextId++}`, ...data };
          state.rows.push(row);
          return row;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { name?: string; members?: string[] };
        }) => {
          const row = state.rows.find((r) => r.id === where.id);
          if (!row) throw new Error("missing");
          Object.assign(row, data);
          return row;
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        state.rows = state.rows.filter((r) => r.id !== where.id);
        return {};
      }),
    },
  };
  return { prisma, db: prisma };
});

const getTeamAvailability = vi.hoisted(() => vi.fn());
vi.mock("../pim/team-availability.js", () => ({ getTeamAvailability }));

import { normalizeMembers, teamRoutes } from "../routes/teams.js";

async function buildApp() {
  const app = Fastify();
  await app.register(teamRoutes, { prefix: "/api/teams" });
  return app;
}

beforeEach(() => {
  state.rows = [];
  state.nextId = 1;
  process.env.TEAM_MODE_ENABLED = "true";
});

describe("normalizeMembers", () => {
  it("dedupes, lowercases, and rejects junk", () => {
    expect(normalizeMembers(["A@B.co", "a@b.co", " c@d.io "])).toEqual(["a@b.co", "c@d.io"]);
    expect(normalizeMembers(["not-an-email"])).toBeNull();
    expect(normalizeMembers([])).toBeNull();
    expect(normalizeMembers("a@b.co")).toBeNull();
  });
});

describe("/api/teams gate", () => {
  it("403s with TEAM_REQUIRED while team mode is dark (paid capability)", async () => {
    process.env.TEAM_MODE_ENABLED = "";
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/teams" });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("TEAM_REQUIRED");
    await app.close();
  });
});

describe("/api/teams", () => {
  it("creates, lists, and deletes a team for the owner", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/teams",
      payload: { name: "AX팀", members: ["alice@corp.com", "bob@corp.com"] },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;

    const list = await app.inject({ method: "GET", url: "/api/teams" });
    expect(list.json().teams).toHaveLength(1);
    expect(list.json().teams[0].name).toBe("AX팀");

    const del = await app.inject({ method: "DELETE", url: `/api/teams/${id}` });
    expect(del.statusCode).toBe(200);
    expect(state.rows).toHaveLength(0);
    await app.close();
  });

  it("400s on junk members and 409s on a duplicate name", async () => {
    const app = await buildApp();
    const junk = await app.inject({
      method: "POST",
      url: "/api/teams",
      payload: { name: "AX팀", members: ["nope"] },
    });
    expect(junk.statusCode).toBe(400);

    await app.inject({
      method: "POST",
      url: "/api/teams",
      payload: { name: "AX팀", members: ["a@b.co"] },
    });
    const dup = await app.inject({
      method: "POST",
      url: "/api/teams",
      payload: { name: "AX팀", members: ["c@d.io"] },
    });
    expect(dup.statusCode).toBe(409);
    await app.close();
  });

  it("serves availability for an owned team and 404s a foreign one", async () => {
    state.rows.push({ id: "t-1", userId: "user-1", name: "AX", members: ["a@b.co"] });
    state.rows.push({ id: "t-x", userId: "user-2", name: "Theirs", members: ["c@d.io"] });
    getTeamAvailability.mockResolvedValue({
      slots: [{ startTime: "2026-08-25T02:00:00.000Z", endTime: "2026-08-25T03:00:00.000Z" }],
      checkedMembers: ["a@b.co"],
      unknownMembers: [],
      timeZone: "Asia/Seoul",
    });
    const app = await buildApp();
    const ok = await app.inject({
      method: "GET",
      url: "/api/teams/t-1/availability?window_start=2026-08-25T00:00:00Z&window_end=2026-08-27T00:00:00Z&duration_minutes=60",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().slots).toHaveLength(1);
    expect(getTeamAvailability).toHaveBeenCalledWith(
      "user-1",
      ["a@b.co"],
      "2026-08-25T00:00:00Z",
      "2026-08-27T00:00:00Z",
      60,
    );
    const foreign = await app.inject({ method: "GET", url: "/api/teams/t-x/availability" });
    expect(foreign.statusCode).toBe(404);
    await app.close();
  });

  it("404s updates/deletes on a team the user does not own", async () => {
    state.rows.push({ id: "t-x", userId: "user-2", name: "Their team", members: ["a@b.co"] });
    const app = await buildApp();
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/teams/t-x",
      payload: { name: "Hijack" },
    });
    expect(patch.statusCode).toBe(404);
    const del = await app.inject({ method: "DELETE", url: "/api/teams/t-x" });
    expect(del.statusCode).toBe(404);
    expect(state.rows[0].name).toBe("Their team");
    await app.close();
  });
});
