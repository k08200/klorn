import type { FastifyInstance } from "fastify";
import { listAgentModePolicies, normalizeAgentMode } from "../agentcore/agent-mode.js";
import { runAgentForUser } from "../agentcore/autonomous-agent.js";
import { getUserId, requireAuth } from "../auth.js";
import { db, prisma } from "../db.js";
import {
  DEFAULT_AUTO_REPLY_GUIDELINE,
  normalizeAttentionMode,
  normalizeAutoReplyGuideline,
} from "../learning/auto-reply-guideline.js";
import { listReplyTonePolicies, normalizeReplyTone } from "../learning/reply-tone.js";
import { createCompletion, DRAFT_MODEL } from "../llm/openai.js";
import {
  NOTIFICATION_LANGUAGES,
  resolveNotificationLanguage,
} from "../notify/notification-strings.js";
import { captureError } from "../sentry.js";
import { normalizeTimeZone, normalizeTimeZoneMode, parseTimeZoneInput } from "../time-zone.js";

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

const agentLogsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "string", maxLength: 500 },
    offset: { type: "string", maxLength: 500 },
  },
} as const;

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
      timezoneMode: normalizeTimeZoneMode(configAny.timezoneMode),
      downloadAutoOrganize: config.downloadAutoOrganize,
      autonomousAgent: configAny.autonomousAgent ?? false,
      agentMode: normalizeAgentMode(configAny.agentMode),
      agentModes: listAgentModePolicies(),
      agentIntervalMin: configAny.agentIntervalMin ?? 5,
      alwaysAllowedTools: sanitizeAlwaysAllowedTools(configAny.alwaysAllowedTools),
      preApprovableTools: Array.from(PRE_APPROVABLE_TOOLS),
      replyTone: normalizeReplyTone(configAny.replyTone),
      replyTones: listReplyTonePolicies(),
      notificationLanguage: resolveNotificationLanguage(
        configAny.notificationLanguage as string | null,
      ),
      notificationLanguages: Array.from(NOTIFICATION_LANGUAGES),
      notifyEmailUrgent: configAny.notifyEmailUrgent ?? true,
      notifyMeeting: configAny.notifyMeeting ?? true,
      notifyTaskDue: configAny.notifyTaskDue ?? true,
      notifyAgentProposal: configAny.notifyAgentProposal ?? true,
      notifyDailyBriefing: configAny.notifyDailyBriefing ?? true,
      notifyEmailCandidate: configAny.notifyEmailCandidate ?? true,
      quietHoursStart: configAny.quietHoursStart ?? null,
      quietHoursEnd: configAny.quietHoursEnd ?? null,
      focusWindowEnabled: configAny.focusWindowEnabled ?? false,
      autoMarkReadEnabled: configAny.autoMarkReadEnabled ?? false,
      proactiveActions: configAny.proactiveActions ?? false,
      phoneEscalationEnabled: configAny.phoneEscalationEnabled ?? false,
      attentionMode: normalizeAttentionMode(configAny.attentionMode),
      autoReplyGuideline: normalizeAutoReplyGuideline(configAny.autoReplyGuideline),
      // The founder default the UI shows as the editable starting draft when
      // autoReplyGuideline is null.
      autoReplyGuidelineDefault: DEFAULT_AUTO_REPLY_GUIDELINE,
    };
  });

  // PATCH /api/automations — Update automation config
  app.patch("/", async (request, reply) => {
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
      "timezoneMode",
      "downloadAutoOrganize",
      "autonomousAgent",
      "agentMode",
      "agentIntervalMin",
      "alwaysAllowedTools",
      "replyTone",
      "notificationLanguage",
      "notifyEmailUrgent",
      "notifyMeeting",
      "focusWindowEnabled",
      "notifyTaskDue",
      "notifyAgentProposal",
      "notifyDailyBriefing",
      "notifyEmailCandidate",
      "quietHoursStart",
      "quietHoursEnd",
      "autoMarkReadEnabled",
      "proactiveActions",
      "phoneEscalationEnabled",
      "attentionMode",
      "autoReplyGuideline",
    ];
    const data: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in body) data[key] = body[key];
    }

    // Validate agentMode
    if ("agentMode" in data) {
      data.agentMode = normalizeAgentMode(data.agentMode);
    }

    // Ontology v2 auto mode: unknown mode → BASIC; guideline is trimmed,
    // capped, and empty → null (null = the founder default applies).
    if ("attentionMode" in data) {
      data.attentionMode = normalizeAttentionMode(data.attentionMode);
    }
    if ("autoReplyGuideline" in data) {
      data.autoReplyGuideline = normalizeAutoReplyGuideline(data.autoReplyGuideline);
    }

    // Validate replyTone — an unknown register would otherwise be persisted
    // and then silently ignored by the prompt builder.
    if ("replyTone" in data) {
      data.replyTone = normalizeReplyTone(data.replyTone);
    }

    // Validate notificationLanguage — an unshipped language would be persisted
    // and then silently fall back to English on every notification.
    if ("notificationLanguage" in data) {
      data.notificationLanguage = resolveNotificationLanguage(
        data.notificationLanguage as string | null,
      );
    }

    // Client-supplied zone: reject anything Intl does not know (400) rather
    // than silently storing the product default over the user's real zone.
    if ("timezone" in data) {
      const timezone = parseTimeZoneInput(data.timezone);
      if (!timezone) return reply.code(400).send({ error: "Invalid timezone" });
      data.timezone = timezone;
    }
    // "AUTO" is stored as null (no saved choice): the client follows the device
    // zone and keeps `timezone` synced to it. "MANUAL" pins `timezone`.
    if ("timezoneMode" in data) {
      const mode = data.timezoneMode;
      if (mode !== "AUTO" && mode !== "MANUAL" && mode !== null) {
        return reply.code(400).send({ error: "Invalid timezoneMode" });
      }
      data.timezoneMode = mode === "MANUAL" ? "MANUAL" : null;
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
      timezoneMode: normalizeTimeZoneMode(configAny.timezoneMode),
      downloadAutoOrganize: config.downloadAutoOrganize,
      autonomousAgent: configAny.autonomousAgent ?? false,
      agentMode: normalizeAgentMode(configAny.agentMode),
      agentModes: listAgentModePolicies(),
      agentIntervalMin: configAny.agentIntervalMin ?? 5,
      alwaysAllowedTools: sanitizeAlwaysAllowedTools(configAny.alwaysAllowedTools),
      preApprovableTools: Array.from(PRE_APPROVABLE_TOOLS),
      replyTone: normalizeReplyTone(configAny.replyTone),
      replyTones: listReplyTonePolicies(),
      notificationLanguage: resolveNotificationLanguage(
        configAny.notificationLanguage as string | null,
      ),
      notificationLanguages: Array.from(NOTIFICATION_LANGUAGES),
      notifyEmailUrgent: configAny.notifyEmailUrgent ?? true,
      notifyMeeting: configAny.notifyMeeting ?? true,
      notifyTaskDue: configAny.notifyTaskDue ?? true,
      notifyAgentProposal: configAny.notifyAgentProposal ?? true,
      notifyDailyBriefing: configAny.notifyDailyBriefing ?? true,
      notifyEmailCandidate: configAny.notifyEmailCandidate ?? true,
      quietHoursStart: configAny.quietHoursStart ?? null,
      quietHoursEnd: configAny.quietHoursEnd ?? null,
      focusWindowEnabled: configAny.focusWindowEnabled ?? false,
      autoMarkReadEnabled: configAny.autoMarkReadEnabled ?? false,
      proactiveActions: configAny.proactiveActions ?? false,
      phoneEscalationEnabled: configAny.phoneEscalationEnabled ?? false,
      attentionMode: normalizeAttentionMode(configAny.attentionMode),
      autoReplyGuideline: normalizeAutoReplyGuideline(configAny.autoReplyGuideline),
      // The founder default the UI shows as the editable starting draft when
      // autoReplyGuideline is null.
      autoReplyGuidelineDefault: DEFAULT_AUTO_REPLY_GUIDELINE,
    };
  });

  // POST /api/automations/guideline-advice — AI feedback on the auto-mode
  // reply guideline (참고용: never applied automatically — the user reads the
  // advice and edits their own text). Rate-limited: each call is an LLM spend.
  app.post(
    "/guideline-advice",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["guideline"],
          properties: { guideline: { type: "string", minLength: 1, maxLength: 2000 } },
        },
      },
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const userId = getUserId(request);
      const { guideline } = request.body as { guideline: string };
      try {
        const response = await createCompletion(
          {
            model: DRAFT_MODEL,
            temperature: 0.3,
            max_tokens: 600,
            messages: [
              {
                role: "system",
                content:
                  "You review a user's standing guideline for UNATTENDED email auto-replies (nobody proofreads before sending). Point out concrete risks and gaps: missing deferral rules for commitments/money/deadlines, ambiguity an LLM could misread, privacy leaks, tone problems. Reply in the same language the guideline is written in, as 2-4 short bullet points. Advice only — do not rewrite the whole guideline.",
              },
              { role: "user", content: guideline },
            ],
          },
          { userId },
        );
        const advice = response.choices[0]?.message?.content?.trim();
        if (!advice) return reply.code(502).send({ error: "No advice produced" });
        return { advice };
      } catch (err) {
        captureError(err, { tags: { scope: "automations.guideline-advice" }, extra: { userId } });
        return reply.code(502).send({ error: "Advice generation failed" });
      }
    },
  );

  // POST /api/automations/run-now — Manually trigger agent for current user
  app.post(
    "/run-now",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
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
    },
  );

  // GET /api/automations/agent-logs — Get autonomous agent activity logs
  app.get("/agent-logs", { schema: { querystring: agentLogsQuerySchema } }, async (request) => {
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
