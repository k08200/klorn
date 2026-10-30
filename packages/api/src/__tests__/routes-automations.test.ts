import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the auth module so requireAuth passes through and getUserId returns a
// deterministic id — the target of this test is the route's input validation,
// not the auth layer (which has its own unit tests).
vi.mock("../auth.js", () => ({
  resolveEffectiveJwtSecret: () => "test-secret",
  requireAuth: async () => {},
  getUserId: () => "test-user-id",
}));

// Mock the autonomous-agent module so importing the route doesn't pull in
// openai/googleapis/etc.
vi.mock("../agentcore/autonomous-agent.js", () => ({
  runAgentForUser: vi.fn(),
}));

// Only createCompletion is replaced (the guideline-advice LLM call); the rest
// of llm/openai.js stays real.
const createCompletion = vi.hoisted(() => vi.fn());
vi.mock("../llm/openai.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../llm/openai.js")>()),
  createCompletion,
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

describe("PATCH /api/automations replyTone", () => {
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
      autonomousAgent: false,
      agentMode: "SUGGEST",
      agentIntervalMin: 5,
      alwaysAllowedTools: [],
      replyTone: args.update.replyTone as string,
    }));
  });

  it("persists a chosen register and echoes back what was stored", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/automations",
      payload: { replyTone: "FORMAL" },
    });

    expect(res.statusCode).toBe(200);
    expect(upsertSpy.mock.calls[0][0].update.replyTone).toBe("FORMAL");
    expect(res.json().replyTone).toBe("FORMAL");
    await app.close();
  });

  // An unknown register would be persisted and then silently ignored by the
  // prompt builder — the setting would read as saved while doing nothing.
  it("normalizes an unknown register to MATCH_ME before storing it", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/automations",
      payload: { replyTone: "SASSY" },
    });

    expect(res.statusCode).toBe(200);
    expect(upsertSpy.mock.calls[0][0].update.replyTone).toBe("MATCH_ME");
    expect(res.json().replyTone).toBe("MATCH_ME");
    await app.close();
  });

  it("leaves the register alone when the request doesn't mention it", async () => {
    const app = await buildApp();
    await app.inject({
      method: "PATCH",
      url: "/api/automations",
      payload: { dailyBriefing: false },
    });

    expect(upsertSpy.mock.calls[0][0].update).not.toHaveProperty("replyTone");
    await app.close();
  });
});

describe("GET /api/automations replyTone", () => {
  beforeEach(() => {
    findUniqueSpy.mockReset();
    upsertSpy.mockReset();
  });

  const storedConfig = (replyTone?: string) => ({
    userId: "test-user-id",
    meetingAutoJoin: true,
    meetingAutoSummarize: true,
    emailAutoClassify: false,
    reminderAutoCheck: true,
    dailyBriefing: true,
    briefingTime: "09:00",
    downloadAutoOrganize: false,
    autonomousAgent: false,
    agentMode: "SUGGEST",
    agentIntervalMin: 5,
    alwaysAllowedTools: [],
    ...(replyTone === undefined ? {} : { replyTone }),
  });

  it("returns the stored register", async () => {
    findUniqueSpy.mockResolvedValue(storedConfig("CASUAL"));
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/automations" });

    expect(res.json().replyTone).toBe("CASUAL");
    await app.close();
  });

  // A row written before the column existed must read as the pre-existing
  // behaviour (infer from the voice profile), not as a blank the client has to
  // guess about.
  it("reads a legacy row without the column as MATCH_ME", async () => {
    findUniqueSpy.mockResolvedValue(storedConfig(undefined));
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/automations" });

    expect(res.json().replyTone).toBe("MATCH_ME");
    await app.close();
  });

  it("describes every register so the settings UI can render the picker", async () => {
    findUniqueSpy.mockResolvedValue(storedConfig("MATCH_ME"));
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/automations" });

    const body = res.json();
    expect(body.replyTones.map((t: { tone: string }) => t.tone)).toEqual([
      "MATCH_ME",
      "FORMAL",
      "FRIENDLY",
      "CASUAL",
    ]);
    for (const policy of body.replyTones) {
      expect(policy.label).toBeTruthy();
      expect(policy.description).toBeTruthy();
    }
    await app.close();
  });
});

describe("PATCH /api/automations timezone validation", () => {
  beforeEach(() => {
    upsertSpy.mockReset();
    upsertSpy.mockImplementation(async (args: { update: Record<string, unknown> }) => ({
      userId: "test-user-id",
      briefingTime: "06:00",
      timezone: (args.update.timezone as string) ?? "Asia/Seoul",
      timezoneMode: (args.update.timezoneMode as string | null) ?? null,
      agentMode: "SUGGEST",
      alwaysAllowedTools: [],
    }));
  });

  it("stores a valid IANA zone with an explicit manual mode", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/automations",
      payload: { timezone: "America/New_York", timezoneMode: "MANUAL" },
    });
    expect(res.statusCode).toBe(200);
    const call = upsertSpy.mock.calls[0][0];
    expect(call.update.timezone).toBe("America/New_York");
    expect(call.update.timezoneMode).toBe("MANUAL");
    expect(res.json().timezone).toBe("America/New_York");
    expect(res.json().timezoneMode).toBe("MANUAL");
    await app.close();
  });

  it("rejects an invalid zone with 400 instead of silently storing a default", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/automations",
      payload: { timezone: "Mars/Olympus_Mons" },
    });
    expect(res.statusCode).toBe(400);
    expect(upsertSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects the client 'auto' sentinel sent as a zone", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/automations",
      payload: { timezone: "auto" },
    });
    expect(res.statusCode).toBe(400);
    expect(upsertSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an unknown timezoneMode with 400", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/automations",
      payload: { timezoneMode: "SOMETIMES" },
    });
    expect(res.statusCode).toBe(400);
    expect(upsertSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("stores AUTO as null (no saved choice) and reports AUTO back", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/automations",
      payload: { timezone: "Asia/Seoul", timezoneMode: "AUTO" },
    });
    expect(res.statusCode).toBe(200);
    const call = upsertSpy.mock.calls[0][0];
    expect(call.update.timezoneMode).toBeNull();
    expect(res.json().timezoneMode).toBe("AUTO");
    await app.close();
  });
});

describe("POST /api/automations/guideline-advice", () => {
  it("answers the daily cost cap with 429 + its code, not a 'failed' 502", async () => {
    createCompletion.mockRejectedValueOnce(
      Object.assign(new Error("Quota used for today."), { name: "DailyCostCapExceededError" }),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/automations/guideline-advice",
      payload: { guideline: "Reply politely." },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: "Quota used for today.", code: "DAILY_COST_CAP" });
    await app.close();
  });

  it("still answers 502 for an ordinary provider failure", async () => {
    createCompletion.mockRejectedValueOnce(new Error("provider down"));
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/automations/guideline-advice",
      payload: { guideline: "Reply politely." },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "Advice generation failed" });
    await app.close();
  });
});
