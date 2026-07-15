import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the auth module so requireAuth passes through and getUserId returns a
// deterministic id — the target of this test is the route's input validation,
// not the auth layer (which has its own unit tests).
vi.mock("../auth.js", () => ({
  requireAuth: async () => {},
  getUserId: () => "test-user-id",
}));

// Mock the autonomous-agent module so importing the route doesn't pull in
// openai/googleapis/etc.
vi.mock("../agentcore/autonomous-agent.js", () => ({
  runAgentForUser: vi.fn(),
}));

// In-memory prisma stub capturing upsert payloads.
const upsertSpy = vi.fn();
const findUniqueSpy = vi.fn();

vi.mock("../db.js", () => {
  const prisma = {
    automationConfig: {
      findUnique: (...args: unknown[]) => findUniqueSpy(...args),
      upsert: (...args: unknown[]) => upsertSpy(...args),
    },
    notification: { create: vi.fn() },
  };
  return { prisma, db: prisma };
});

async function buildApp() {
  const { automationRoutes } = await import("../routes/automations.js");
  const app = Fastify();
  await app.register(automationRoutes, { prefix: "/api/automations" });
  return app;
}

describe("PATCH /api/automations alwaysAllowedTools validation", () => {
  beforeEach(() => {
    upsertSpy.mockReset();
    findUniqueSpy.mockReset();
    upsertSpy.mockImplementation(async (args: { update: Record<string, unknown> }) => ({
      userId: "test-user-id",
      meetingAutoJoin: true,
      meetingAutoSummarize: true,
      emailAutoClassify: false,
      reminderAutoCheck: true,
      dailyBriefing: true,
      briefingTime: "09:00",
      downloadAutoOrganize: false,
      autonomousAgent: true,
      agentMode: (args.update.agentMode as string) ?? "AUTO",
      agentIntervalMin: 5,
      alwaysAllowedTools: (args.update.alwaysAllowedTools as string[]) ?? [],
      phoneEscalationEnabled: (args.update.phoneEscalationEnabled as boolean) ?? false,
    }));
  });

  it("accepts pre-approvable MEDIUM-risk tool names", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/automations",
      payload: { alwaysAllowedTools: ["create_event", "create_note"] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.alwaysAllowedTools).toEqual(["create_event", "create_note"]);

    const call = upsertSpy.mock.calls[0][0];
    expect(call.update.alwaysAllowedTools).toEqual(["create_event", "create_note"]);
    await app.close();
  });

  it("does not allow email sending to be pre-approved", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/automations",
      payload: { alwaysAllowedTools: ["send_email", "create_event"] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.alwaysAllowedTools).toEqual(["create_event"]);

    const call = upsertSpy.mock.calls[0][0];
    expect(call.update.alwaysAllowedTools).toEqual(["create_event"]);
    await app.close();
  });

  it("accepts SHADOW mode", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/automations",
      payload: { agentMode: "SHADOW" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().agentMode).toBe("SHADOW");

    const call = upsertSpy.mock.calls[0][0];
    expect(call.update.agentMode).toBe("SHADOW");
    await app.close();
  });

  it("defaults autonomousAgent to false when the stored config omits it", async () => {
    // A legacy/partial config row with no explicit agent setting must serialize
    // as OFF — the firewall doctrine default is classify-only, no proactive
    // agent loop. Guards against the field silently reading back as enabled.
    findUniqueSpy.mockResolvedValueOnce({
      userId: "test-user-id",
      agentMode: "SUGGEST",
      // autonomousAgent intentionally absent (undefined)
    });

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/automations" });

    expect(res.statusCode).toBe(200);
    expect(res.json().autonomousAgent).toBe(false);
    await app.close();
  });

  it("normalizes unknown agent modes to SUGGEST", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/automations",
      payload: { agentMode: "LOUD" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().agentMode).toBe("SUGGEST");

    const call = upsertSpy.mock.calls[0][0];
    expect(call.update.agentMode).toBe("SUGGEST");
    await app.close();
  });

  it("drops HIGH-risk tool names even when the client sends them", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/automations",
      payload: {
        alwaysAllowedTools: ["create_event", "delete_email", "archive_email", "delete_task"],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.alwaysAllowedTools).toEqual(["create_event"]);

    const call = upsertSpy.mock.calls[0][0];
    expect(call.update.alwaysAllowedTools).toEqual(["create_event"]);
    await app.close();
  });

  it("drops unknown tool names", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/automations",
      payload: { alwaysAllowedTools: ["create_event", "hack_the_planet", "rm_rf_slash"] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.alwaysAllowedTools).toEqual(["create_event"]);
    await app.close();
  });

  it("deduplicates repeated tool names", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/automations",
      payload: { alwaysAllowedTools: ["create_event", "create_event", "create_note"] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.alwaysAllowedTools).toEqual(["create_event", "create_note"]);
    await app.close();
  });

  it("coerces non-array input to an empty list", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/automations",
      payload: { alwaysAllowedTools: "send_email" },
    });

    expect(res.statusCode).toBe(200);
    const call = upsertSpy.mock.calls[0][0];
    expect(call.update.alwaysAllowedTools).toEqual([]);
    await app.close();
  });

  it("persists phoneEscalationEnabled (whitelisted field)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/automations",
      payload: { phoneEscalationEnabled: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().phoneEscalationEnabled).toBe(true);

    const call = upsertSpy.mock.calls[0][0];
    expect(call.update.phoneEscalationEnabled).toBe(true);
    await app.close();
  });

  it("ignores unknown top-level fields", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/automations",
      payload: {
        alwaysAllowedTools: ["send_email", "create_event"],
        forbidden_field: "should not reach upsert",
        userId: "other-user-id",
      },
    });

    expect(res.statusCode).toBe(200);
    const call = upsertSpy.mock.calls[0][0];
    expect("forbidden_field" in call.update).toBe(false);
    expect("userId" in call.update).toBe(false);
    await app.close();
  });
});

describe("GET /api/automations", () => {
  beforeEach(() => {
    findUniqueSpy.mockReset();
    upsertSpy.mockReset();
  });

  it("exposes alwaysAllowedTools and the preApprovableTools whitelist", async () => {
    findUniqueSpy.mockResolvedValue({
      userId: "test-user-id",
      meetingAutoJoin: true,
      meetingAutoSummarize: true,
      emailAutoClassify: false,
      reminderAutoCheck: true,
      dailyBriefing: true,
      briefingTime: "09:00",
      downloadAutoOrganize: false,
      autonomousAgent: true,
      agentMode: "AUTO",
      agentIntervalMin: 5,
      alwaysAllowedTools: ["send_email", "create_event"],
    });

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/automations" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.alwaysAllowedTools).toEqual(["create_event"]);
    expect(body.agentModes.map((m: { mode: string }) => m.mode)).toEqual([
      "SHADOW",
      "SUGGEST",
      "AUTO",
    ]);
    expect(body.agentModes[0]).toMatchObject({
      mode: "SHADOW",
      autonomyLevel: 0,
      proposalNotifications: false,
    });
    // The whitelist must only contain MEDIUM-risk tools the user may pre-approve.
    expect(body.preApprovableTools).toEqual(
      expect.arrayContaining(["create_event", "create_note", "update_contact", "create_contact"]),
    );
    expect(body.preApprovableTools).not.toContain("send_email");
    // HIGH-risk tools must never appear in the whitelist.
    expect(body.preApprovableTools).not.toContain("delete_email");
    expect(body.preApprovableTools).not.toContain("archive_email");
    expect(body.preApprovableTools).not.toContain("delete_task");
    await app.close();
  });

  it("exposes phoneEscalationEnabled (default false when unset)", async () => {
    findUniqueSpy.mockResolvedValue({
      userId: "test-user-id",
      meetingAutoJoin: true,
      meetingAutoSummarize: true,
      emailAutoClassify: false,
      reminderAutoCheck: true,
      dailyBriefing: true,
      briefingTime: "09:00",
      downloadAutoOrganize: false,
      autonomousAgent: true,
      agentMode: "AUTO",
      agentIntervalMin: 5,
      alwaysAllowedTools: [],
      phoneEscalationEnabled: true,
    });

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/automations" });

    expect(res.statusCode).toBe(200);
    expect(res.json().phoneEscalationEnabled).toBe(true);
    await app.close();
  });
});
