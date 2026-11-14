/**
 * Meeting prep on the briefing routes (Context Engine slice 1): GET /today
 * carries `meetingPrep` only when CONTEXT_MEETING_PREP_ENABLED opens to the
 * caller, and a prep failure never breaks the briefing; GET /meeting-prep is
 * dark (404) unless the flag opens to the caller, and only ever reads the
 * caller's own prep — it takes no id to tamper with.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const BLOCK = vi.hoisted(() => ({
  generatedAt: "2099-03-02T00:00:00.000Z",
  meetings: [
    {
      eventId: "ev-1",
      title: "Acme sync",
      startTime: "2099-03-02T10:00:00.000Z",
      endTime: "2099-03-02T11:00:00.000Z",
      attendees: ["alice@acme.com"],
      items: [
        {
          kind: "unanswered" as const,
          from: "Alice",
          subject: "Quote",
          receivedAt: "2099-03-01T00:00:00.000Z",
          match: "address" as const,
          source: { kind: "email" as const, emailId: "m-1" },
        },
      ],
    },
  ],
}));

vi.mock("../llm/openai.js", () => ({ MODEL: "test-model", createCompletion: vi.fn() }));
vi.mock("../pim/briefing-structure.js", () => ({
  buildBriefingStructure: vi.fn(async () => null),
}));
vi.mock("../context/meeting-prep.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context/meeting-prep.js")>()),
  buildMeetingPrep: vi.fn(async () => BLOCK),
}));
vi.mock("../db.js", () => {
  const prisma = {
    note: {
      findFirst: vi.fn(async () => ({
        id: "note-1",
        content: "Today.",
        createdAt: new Date(),
        picks: null,
      })),
    },
    automationConfig: { findUnique: vi.fn(async () => ({ timezone: "UTC" })) },
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })) },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      count: vi.fn(async () => 0),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});

import { buildMeetingPrep } from "../context/meeting-prep.js";
import { prisma } from "../db.js";

function auth(userId = "user-1") {
  return { authorization: `Bearer ${signToken({ userId, email: `${userId}@example.com` })}` };
}

async function buildApp() {
  const { briefingRoutes } = await import("../pim/briefing.js");
  const app = Fastify();
  await app.register(briefingRoutes, { prefix: "/api/briefing" });
  return app;
}

beforeEach(() => {
  delete process.env.CONTEXT_MEETING_PREP_ENABLED;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
  vi.mocked(buildMeetingPrep).mockReset();
  vi.mocked(buildMeetingPrep).mockResolvedValue(BLOCK);
});

describe("flag off (default)", () => {
  it("GET /today has no meetingPrep and builds none", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/briefing/today", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty("meetingPrep");
    expect(buildMeetingPrep).not.toHaveBeenCalled();
  });

  it("GET /meeting-prep is dark", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/briefing/meeting-prep",
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
    expect(buildMeetingPrep).not.toHaveBeenCalled();
  });
});

describe("flag on", () => {
  beforeEach(() => {
    process.env.CONTEXT_MEETING_PREP_ENABLED = "true";
  });

  it("GET /today carries the caller's block", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/briefing/today", headers: auth() });
    expect(res.json().meetingPrep).toEqual(BLOCK);
    expect(vi.mocked(buildMeetingPrep).mock.calls[0]?.[0]).toBe("user-1");
  });

  it("GET /today still answers when prep fails", async () => {
    vi.mocked(buildMeetingPrep).mockRejectedValue(new Error("db down"));
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/briefing/today", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().briefing.id).toBe("note-1");
    expect(res.json()).not.toHaveProperty("meetingPrep");
  });

  it("GET /meeting-prep returns the block, empty when there is nothing to prep", async () => {
    const app = await buildApp();
    const full = await app.inject({
      method: "GET",
      url: "/api/briefing/meeting-prep",
      headers: auth(),
    });
    expect(full.statusCode).toBe(200);
    expect(full.json()).toEqual({ meetingPrep: BLOCK });

    vi.mocked(buildMeetingPrep).mockResolvedValue(null);
    const none = await app.inject({
      method: "GET",
      url: "/api/briefing/meeting-prep",
      headers: auth(),
    });
    expect(none.json().meetingPrep.meetings).toEqual([]);
  });

  it("GET /meeting-prep answers 503 on failure, without the error's details", async () => {
    vi.mocked(buildMeetingPrep).mockRejectedValue(new Error("query failed: alice@acme.com"));
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/briefing/meeting-prep",
      headers: auth(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("alice@acme.com");
  });

  it("GET /today refuses a revoked session (no device row) before building prep", async () => {
    vi.mocked(prisma.device.findUnique).mockResolvedValueOnce(null);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/briefing/today", headers: auth() });
    expect(res.statusCode).toBe(401);
    expect(buildMeetingPrep).not.toHaveBeenCalled();
  });

  it("GET /meeting-prep requires a session and ignores any user id in the request", async () => {
    const app = await buildApp();
    const anon = await app.inject({ method: "GET", url: "/api/briefing/meeting-prep" });
    expect(anon.statusCode).toBe(401);
    await app.inject({
      method: "GET",
      url: "/api/briefing/meeting-prep?userId=user-2",
      headers: auth("user-1"),
    });
    expect(vi.mocked(buildMeetingPrep).mock.calls.map((c) => c[0])).toEqual(["user-1"]);
  });
});

describe("flag cohort", () => {
  beforeEach(() => {
    process.env.CONTEXT_MEETING_PREP_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "user-1";
  });

  it("only the cohort sees prep", async () => {
    const app = await buildApp();
    const inside = await app.inject({
      method: "GET",
      url: "/api/briefing/meeting-prep",
      headers: auth("user-1"),
    });
    expect(inside.statusCode).toBe(200);
    const outside = await app.inject({
      method: "GET",
      url: "/api/briefing/meeting-prep",
      headers: auth("user-2"),
    });
    expect(outside.statusCode).toBe(404);
    const today = await app.inject({
      method: "GET",
      url: "/api/briefing/today",
      headers: auth("user-2"),
    });
    expect(today.json()).not.toHaveProperty("meetingPrep");
  });
});
