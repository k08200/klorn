import type { FastifyInstance } from "fastify";
import { listAgentModePolicies, normalizeAgentMode } from "../agent-mode.js";
import { getUserId, requireAuth } from "../auth.js";
import { runAgentForUser } from "../autonomous-agent.js";
import { db, prisma } from "../db.js";
import { normalizeTimeZone } from "../time-zone.js";

// MEDIUM-risk tools that users may pre-approve for AUTO mode.
// Email sending is intentionally excluded for dogfood safety: a bad auto-reply
// costs more trust than the saved click is worth at this stage.
// HIGH-risk tools (delete_*, archive_email) are intentionally excluded — they
// always require per-action approval.
const PRE_APPROVABLE_TOOLS = new Set([
  "create_event",
  "create_note",
  "update_contact",
  "create_contact",
]);

function sanitizeAlwaysAllowedTools(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value.filter((t): t is string => typeof t === "string" && PRE_APPROVABLE_TOOLS.has(t))
    : [];
  return Array.from(new Set(list));
}

export async function automationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // GET /api/automations — Get user's automation config
  app.get("/", async (request) => {
    const userId = getUserId(request);

    let config = await prisma.automationConfig.findUnique({ where: { userId } });

    // Create default config if none exists
    if (!config) {
      config = await prisma.automationConfig.create({ data: { userId } });
    }

    const configAny = config as Record<string, unknown>;
    return {
      meetingAutoJoin: config.meetingAutoJoin,
      meetingAutoSummarize: config.meetingAutoSummarize,
      emailAutoClassify: config.emailAutoClassify,
      reminderAutoCheck: config.reminderAutoCheck,
      dailyBriefing: config.dailyBriefing,
      briefingTime: config.briefingTime,
      timezone: normalizeTimeZone(configAny.timezone),
      downloadAutoOrganize: config.downloadAutoOrganize,
      autonomousAgent: configAny.autonomousAgent ?? true,
      agentMode: normalizeAgentMode(configAny.agentMode),
      agentModes: listAgentModePolicies(),
      agentIntervalMin: configAny.agentIntervalMin ?? 5,
      alwaysAllowedTools: sanitizeAlwaysAllowedTools(configAny.alwaysAllowedTools),
      preApprovableTools: Array.from(PRE_APPROVABLE_TOOLS),
      notifyEmailUrgent: configAny.notifyEmailUrgent ?? true,
      notifyMeeting: configAny.notifyMeeting ?? true,
      notifyTaskDue: configAny.notifyTaskDue ?? true,
      notifyAgentProposal: configAny.notifyAgentProposal ?? true,
      notifyDailyBriefing: configAny.notifyDailyBriefing ?? true,
      notifyEmailCandidate: configAny.notifyEmailCandidate ?? true,
      quietHoursStart: configAny.quietHoursStart ?? null,
      quietHoursEnd: configAny.quietHoursEnd ?? null,
      autoMarkReadEnabled: configAny.autoMarkReadEnabled ?? false,
      proactiveActions: configAny.proactiveActions ?? false,
    };
  });

  // PATCH /api/automations — Update automation config
  app.patch("/", async (request) => {
    const userId = getUserId(request);
    const body = request.body as Record<string, unknown>;

    // Only allow known fields
    const allowed = [
      "meetingAutoJoin",
      "meetingAutoSummarize",
      "emailAutoClassify",
      "reminderAutoCheck",
      "dailyBriefing",
      "briefingTime",
      "timezone",
      "downloadAutoOrganize",
      "autonomousAgent",
      "agentMode",
      "agentIntervalMin",
      "alwaysAllowedTools",
      "notifyEmailUrgent",
      "notifyMeeting",
      "notifyTaskDue",
      "notifyAgentProposal",
      "notifyDailyBriefing",
      "notifyEmailCandidate",
      "quietHoursStart",
      "quietHoursEnd",
      "autoMarkReadEnabled",
      "proactiveActions",
    ];
    const data: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in body) data[key] = body[key];
    }

    // Validate agentMode
    if ("agentMode" in data) {
      data.agentMode = normalizeAgentMode(data.agentMode);
    }

    if ("timezone" in data) {
      data.timezone = normalizeTimeZone(data.timezone);
    }

    // Validate alwaysAllowedTools — only MEDIUM-risk tools from the whitelist
    // are permitted. Drop unknown or HIGH-risk tool names silently.
    if ("alwaysAllowedTools" in data) {
      data.alwaysAllowedTools = sanitizeAlwaysAllowedTools(data.alwaysAllowedTools);
    }

    const config = await prisma.automationConfig.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });

    const configAny = config as Record<string, unknown>;
    return {
      meetingAutoJoin: config.meetingAutoJoin,
      meetingAutoSummarize: config.meetingAutoSummarize,
      emailAutoClassify: config.emailAutoClassify,
      reminderAutoCheck: config.reminderAutoCheck,
      dailyBriefing: config.dailyBriefing,
      briefingTime: config.briefingTime,
      timezone: normalizeTimeZone(configAny.timezone),
      downloadAutoOrganize: config.downloadAutoOrganize,
      autonomousAgent: configAny.autonomousAgent ?? true,
      agentMode: normalizeAgentMode(configAny.agentMode),
      agentModes: listAgentModePolicies(),
      agentIntervalMin: configAny.agentIntervalMin ?? 5,
      alwaysAllowedTools: sanitizeAlwaysAllowedTools(configAny.alwaysAllowedTools),
      preApprovableTools: Array.from(PRE_APPROVABLE_TOOLS),
      notifyEmailUrgent: configAny.notifyEmailUrgent ?? true,
      notifyMeeting: configAny.notifyMeeting ?? true,
      notifyTaskDue: configAny.notifyTaskDue ?? true,
      notifyAgentProposal: configAny.notifyAgentProposal ?? true,
      notifyDailyBriefing: configAny.notifyDailyBriefing ?? true,
      notifyEmailCandidate: configAny.notifyEmailCandidate ?? true,
      quietHoursStart: configAny.quietHoursStart ?? null,
      quietHoursEnd: configAny.quietHoursEnd ?? null,
      autoMarkReadEnabled: configAny.autoMarkReadEnabled ?? false,
      proactiveActions: configAny.proactiveActions ?? false,
    };
  });

  // POST /api/automations/run-now — Manually trigger agent for current user
  app.post("/run-now", async (request) => {
    const userId = getUserId(request);
    if (userId === "demo-user") {
      return { error: "Agent not available for demo user" };
    }

    const config = await prisma.automationConfig.findUnique({ where: { userId } });
    const mode = normalizeAgentMode((config as Record<string, unknown>)?.agentMode);

    // Run in background so the response returns immediately
    runAgentForUser(userId, mode).catch((err) => {
      console.error(`[AGENT] Manual run failed for ${userId}:`, err);
    });

    return { triggered: true, mode };
  });

  // GET /api/automations/agent-logs — Get autonomous agent activity logs
  app.get("/agent-logs", async (request) => {
    const userId = getUserId(request);
    const { limit, offset } = (request.query || {}) as { limit?: string; offset?: string };

    const logs = await db.agentLog.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(limit) || 50, 100),
      skip: Number(offset) || 0,
    });

    return { logs };
  });

  // GET /api/automations/today-actions — "What did Klorn do for me today?"
  //
  // Aggregates PendingAction status transitions for the calling user since UTC
  // midnight + currently-open proposals + urgent notifications today, into one
  // shape the briefing page can render as a 5-line card without doing 4
  // separate queries from the client.
  app.get("/today-actions", async (request) => {
    const userId = getUserId(request);
    const sinceUtc = new Date();
    sinceUtc.setUTCHours(0, 0, 0, 0);

    type ActionRow = {
      id: string;
      toolName: string;
      reasoning: string | null;
      result: string | null;
      conversationId: string;
      createdAt: Date;
      updatedAt: Date;
    };

    const [executedToday, rejectedToday, pendingOpen, urgentToday] = (await Promise.all([
      db.pendingAction.findMany({
        where: { userId, status: "EXECUTED", updatedAt: { gte: sinceUtc } },
        orderBy: { updatedAt: "desc" },
        take: 8,
      }),
      db.pendingAction.findMany({
        where: { userId, status: "REJECTED", updatedAt: { gte: sinceUtc } },
        orderBy: { updatedAt: "desc" },
        take: 8,
      }),
      db.pendingAction.findMany({
        where: { userId, status: "PENDING" },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
      prisma.notification.findMany({
        where: {
          userId,
          type: "email",
          createdAt: { gte: sinceUtc },
          OR: [{ title: "Urgent email" }, { title: "긴급 이메일" }],
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, message: true, link: true, createdAt: true },
        take: 8,
      }),
    ])) as [
      ActionRow[],
      ActionRow[],
      ActionRow[],
      Array<{ id: string; message: string; link: string | null; createdAt: Date }>,
    ];

    return {
      sinceUtc: sinceUtc.toISOString(),
      executed: executedToday.map((row) => ({
        id: row.id,
        toolName: row.toolName,
        summary: (row.reasoning ?? "").slice(0, 200),
        at: row.updatedAt.toISOString(),
      })),
      rejected: rejectedToday.map((row) => ({
        id: row.id,
        toolName: row.toolName,
        reason: (row.result ?? "").slice(0, 200),
        at: row.updatedAt.toISOString(),
      })),
      pending: pendingOpen.map((row) => ({
        id: row.id,
        toolName: row.toolName,
        summary: (row.reasoning ?? "").slice(0, 200),
        conversationId: row.conversationId,
        at: row.createdAt.toISOString(),
      })),
      urgent: urgentToday.map((row) => ({
        id: row.id,
        message: row.message,
        link: row.link ?? null,
        at: row.createdAt.toISOString(),
      })),
      totals: {
        executed: executedToday.length,
        rejected: rejectedToday.length,
        pending: pendingOpen.length,
        urgent: urgentToday.length,
      },
    };
  });
}
