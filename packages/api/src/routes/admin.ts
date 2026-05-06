import type { FastifyInstance } from "fastify";
import { runAllScenarios, summarizeEval } from "../agent-eval.js";
import { requireAdmin } from "../auth.js";
import { db, prisma } from "../db.js";
import { getPerfSnapshot } from "../perf-monitor.js";

type FeedbackGroup = { signal: string; _count: { signal: number } };

function summarizeTrustFeedback(rows: FeedbackGroup[]) {
  const counts = { useful: 0, wrong: 0, later: 0, done: 0 };
  for (const row of rows) {
    if (row.signal === "APPROVED") counts.useful += row._count.signal;
    if (row.signal === "REJECTED") counts.wrong += row._count.signal;
    if (row.signal === "SNOOZED") counts.later += row._count.signal;
    if (row.signal === "DISMISSED") counts.done += row._count.signal;
  }
  const total = counts.useful + counts.wrong + counts.later + counts.done;
  return {
    total,
    ...counts,
    usefulRate: total > 0 ? counts.useful / total : null,
  };
}

export async function adminRoutes(app: FastifyInstance) {
  // All admin routes require ADMIN role
  app.addHook("preHandler", requireAdmin);

  // GET /api/admin/users — List all users
  app.get("/users", async () => {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        plan: true,
        stripeId: true,
        createdAt: true,
        _count: {
          select: {
            conversations: true,
            tasks: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Add monthly message count for each user
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const usersWithUsage = await Promise.all(
      users.map(async (user: (typeof users)[number]) => {
        const messageCount = await prisma.message.count({
          where: {
            conversation: { userId: user.id },
            role: "USER",
            createdAt: { gte: periodStart },
          },
        });
        return { ...user, messageCount };
      }),
    );

    return { users: usersWithUsage };
  });

  // PATCH /api/admin/users/:id — Update user plan or role
  app.patch("/users/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { plan, role } = request.body as { plan?: string; role?: string };

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: "User not found" });

    const data: Record<string, string> = {};
    if (plan && ["FREE", "PRO", "TEAM", "ENTERPRISE"].includes(plan)) {
      data.plan = plan;
    }
    if (role && ["USER", "ADMIN"].includes(role)) {
      data.role = role;
    }

    if (Object.keys(data).length === 0) {
      return reply.code(400).send({ error: "No valid fields to update" });
    }

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, email: true, name: true, role: true, plan: true },
    });

    return updated;
  });

  // DELETE /api/admin/users/:id — Delete user and all their data
  app.delete("/users/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: "User not found" });
    if (user.role === "ADMIN") {
      return reply.code(400).send({ error: "Cannot delete admin user" });
    }

    await prisma.$transaction([
      prisma.notification.deleteMany({ where: { userId: id } }),
      prisma.automationConfig.deleteMany({ where: { userId: id } }),
      prisma.calendarEvent.deleteMany({ where: { userId: id } }),
      prisma.contact.deleteMany({ where: { userId: id } }),
      prisma.reminder.deleteMany({ where: { userId: id } }),
      prisma.note.deleteMany({ where: { userId: id } }),
      prisma.task.deleteMany({ where: { userId: id } }),
      prisma.commitment.deleteMany({ where: { userId: id } }),
      prisma.feedbackEvent.deleteMany({ where: { userId: id } }),
      prisma.message.deleteMany({ where: { conversation: { userId: id } } }),
      prisma.conversation.deleteMany({ where: { userId: id } }),
      prisma.userToken.deleteMany({ where: { userId: id } }),
      prisma.evaluation.deleteMany({ where: { testRun: { userId: id } } }),
      prisma.testRun.deleteMany({ where: { userId: id } }),
      prisma.agent.deleteMany({ where: { userId: id } }),
      prisma.workspaceMember.deleteMany({ where: { userId: id } }),
      prisma.user.delete({ where: { id } }),
    ]);

    return reply.code(204).send();
  });

  // GET /api/admin/stats — Dashboard stats
  app.get("/stats", async () => {
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [totalUsers, totalConversations, totalMessages, planDistribution] = await Promise.all([
      prisma.user.count(),
      prisma.conversation.count(),
      prisma.message.count({ where: { createdAt: { gte: periodStart } } }),
      prisma.user.groupBy({ by: ["plan"], _count: { id: true } }),
    ]);

    return {
      totalUsers,
      totalConversations,
      monthlyMessages: totalMessages,
      planDistribution: Object.fromEntries(
        planDistribution.map((p: { plan: string; _count: { id: number } }) => [
          p.plan,
          p._count.id,
        ]),
      ),
    };
  });

  // GET /api/admin/ops — Operational metrics (tool success rate, approval rate, DAU, token cost, etc.)
  app.get("/ops", async () => {
    const now = new Date();
    const day = 24 * 60 * 60 * 1000;
    const last24h = new Date(now.getTime() - day);
    const last7d = new Date(now.getTime() - 7 * day);
    const last30d = new Date(now.getTime() - 30 * day);

    // Tool success/failure from AgentLog (action: auto_action|error|skip)
    const [toolExecuted, toolErrors, toolSkipped] = await Promise.all([
      db.agentLog.count({ where: { action: "auto_action", createdAt: { gte: last7d } } }),
      db.agentLog.count({ where: { action: "error", createdAt: { gte: last7d } } }),
      db.agentLog.count({ where: { action: "skip", createdAt: { gte: last7d } } }),
    ]);
    const totalToolCalls = toolExecuted + toolErrors;
    const toolSuccessRate = totalToolCalls > 0 ? toolExecuted / totalToolCalls : 0;

    // Approval rate from PendingAction
    const [proposed, approved, rejected, stillPending] = await Promise.all([
      db.pendingAction.count({ where: { createdAt: { gte: last7d } } }),
      db.pendingAction.count({ where: { status: "EXECUTED", createdAt: { gte: last7d } } }),
      db.pendingAction.count({ where: { status: "REJECTED", createdAt: { gte: last7d } } }),
      db.pendingAction.count({ where: { status: "PENDING", createdAt: { gte: last7d } } }),
    ]);
    const decided = approved + rejected;
    const approvalRate = decided > 0 ? approved / decided : 0;

    // Notification read rate
    const [notifSent, notifRead] = await Promise.all([
      prisma.notification.count({ where: { createdAt: { gte: last7d } } }),
      prisma.notification.count({ where: { createdAt: { gte: last7d }, isRead: true } }),
    ]);
    const readRate = notifSent > 0 ? notifRead / notifSent : 0;

    const [briefingFeedback, replyNeededFeedback] = await Promise.all([
      prisma.feedbackEvent.groupBy({
        by: ["signal"],
        where: {
          source: "ATTENTION_ITEM",
          toolName: "briefing_top_action",
          createdAt: { gte: last7d },
        },
        _count: { signal: true },
      }),
      prisma.feedbackEvent.groupBy({
        by: ["signal"],
        where: {
          source: "ATTENTION_ITEM",
          toolName: "reply_needed",
          createdAt: { gte: last7d },
        },
        _count: { signal: true },
      }),
    ]);

    // Active users
    const [dau, wau, mau] = await Promise.all([
      prisma.message
        .groupBy({
          by: ["conversationId"],
          where: { createdAt: { gte: last24h }, role: "USER" },
        })
        .then((g: { conversationId: string }[]) => g.length),
      prisma.message
        .groupBy({
          by: ["conversationId"],
          where: { createdAt: { gte: last7d }, role: "USER" },
        })
        .then((g: { conversationId: string }[]) => g.length),
      prisma.message
        .groupBy({
          by: ["conversationId"],
          where: { createdAt: { gte: last30d }, role: "USER" },
        })
        .then((g: { conversationId: string }[]) => g.length),
    ]);

    // Token usage + estimated cost
    const tokenAgg = await db.tokenUsage.aggregate({
      where: { createdAt: { gte: last7d } },
      _sum: { promptTokens: true, completionTokens: true, totalTokens: true, estimatedCost: true },
    });
    const promptTokens = Number(tokenAgg._sum?.promptTokens ?? 0);
    const completionTokens = Number(tokenAgg._sum?.completionTokens ?? 0);
    const totalTokens = Number(tokenAgg._sum?.totalTokens ?? 0);
    const estimatedCostUsd = Number(tokenAgg._sum?.estimatedCost ?? 0);

    // Top errors (last 7d)
    const recentErrors = await db.agentLog.findMany({
      where: { action: "error", createdAt: { gte: last7d } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { summary: true, createdAt: true, userId: true, tool: true },
    });

    return {
      window: "7d",
      tools: {
        executed: toolExecuted,
        errors: toolErrors,
        skipped: toolSkipped,
        successRate: toolSuccessRate,
      },
      approvals: {
        proposed,
        approved,
        rejected,
        pending: stillPending,
        approvalRate,
      },
      notifications: {
        sent: notifSent,
        read: notifRead,
        readRate,
      },
      trust: {
        briefingTop3: summarizeTrustFeedback(briefingFeedback),
        replyNeeded: summarizeTrustFeedback(replyNeededFeedback),
      },
      activeUsers: { dau, wau, mau },
      tokens: {
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedCostUsd,
      },
      recentErrors,
    };
  });

  // GET /api/admin/perf — Per-route latency (p50/p95/p99) since last server restart
  app.get("/perf", async () => {
    const snapshot = getPerfSnapshot();
    return { routes: snapshot, capturedAt: new Date().toISOString() };
  });

  // GET /api/admin/waitlist — Public waitlist entries (PENDING first)
  app.get("/waitlist", async (request) => {
    const { status } = request.query as { status?: string };
    const where = status === "APPROVED" || status === "REJECTED" ? { status } : {};
    const entries = await db.waitlist.findMany({
      where,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 200,
    });
    const countRows = (await db.waitlist.groupBy({
      by: ["status"],
      _count: { status: true },
    })) as Array<{ status: string; _count: { status: number } }>;
    const counts: Record<string, number> = {};
    for (const row of countRows) {
      counts[row.status] = row._count.status;
    }
    return { entries, counts };
  });

  // PATCH /api/admin/waitlist/:id — mark approved or rejected
  app.patch("/waitlist/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status } = request.body as { status?: string };
    if (status !== "APPROVED" && status !== "REJECTED" && status !== "PENDING") {
      return reply.code(400).send({ error: "status must be APPROVED, REJECTED, or PENDING" });
    }
    const entry = await db.waitlist.update({
      where: { id },
      data: {
        status,
        approvedAt: status === "APPROVED" ? new Date() : null,
      },
    });
    return entry;
  });

  // GET /api/admin/eval — Run agent decision-logic eval scenarios
  app.get("/eval", async () => {
    const results = runAllScenarios();
    return {
      summary: summarizeEval(results),
      results: results.map((r) => ({
        id: r.scenario.id,
        name: r.scenario.name,
        description: r.scenario.description,
        category: r.scenario.category,
        severity: r.scenario.severity,
        passed: r.passed,
        message: r.message,
      })),
      runAt: new Date().toISOString(),
    };
  });
}
