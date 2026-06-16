/**
 * Token Usage API — Inspired by Claude Code's cost-tracker.ts
 *
 * Provides endpoints for viewing token usage stats per user and per conversation.
 */

import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { db, prisma } from "../db.js";

// Per-route rate limit config
const rateLimitConfig = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };

interface UsageRow {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCost: number;
  createdAt: Date;
}

export async function tokenUsageRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // GET /api/usage — Overall usage stats for the current user
  app.get("/", rateLimitConfig, async (request) => {
    const userId = getUserId(request);
    const { period } = request.query as { period?: string };

    // Default period: current month
    const now = new Date();
    let since: Date;
    if (period === "week") {
      since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (period === "all") {
      since = new Date(0);
    } else {
      // "month" (default)
      since = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const usages: UsageRow[] = await db.tokenUsage.findMany({
      where: { userId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
    });

    const totalTokens = usages.reduce((sum: number, u: UsageRow) => sum + u.totalTokens, 0);
    const totalCost = usages.reduce((sum: number, u: UsageRow) => sum + u.estimatedCost, 0);
    const totalPromptTokens = usages.reduce((sum: number, u: UsageRow) => sum + u.promptTokens, 0);
    const totalCompletionTokens = usages.reduce(
      (sum: number, u: UsageRow) => sum + u.completionTokens,
      0,
    );
    const messageCount = usages.length;

    // Daily breakdown
    const dailyMap = new Map<string, { tokens: number; cost: number; messages: number }>();
    for (const u of usages) {
      const day = u.createdAt.toISOString().split("T")[0];
      const existing = dailyMap.get(day) || { tokens: 0, cost: 0, messages: 0 };
      existing.tokens += u.totalTokens;
      existing.cost += u.estimatedCost;
      existing.messages += 1;
      dailyMap.set(day, existing);
    }

    return {
      period: period || "month",
      since: since.toISOString(),
      summary: {
        totalTokens,
        totalPromptTokens,
        totalCompletionTokens,
        totalCost: Math.round(totalCost * 10000) / 10000,
        messageCount,
      },
      daily: Array.from(dailyMap.entries())
        .map(([date, stats]) => ({
          date,
          ...stats,
          cost: Math.round(stats.cost * 10000) / 10000,
        }))
        .sort((a, b) => b.date.localeCompare(a.date)),
    };
  });

  // GET /api/usage/conversations — Per-conversation breakdown
  app.get("/conversations", rateLimitConfig, async (request) => {
    const userId = getUserId(request);

    const usages = await db.tokenUsage.groupBy({
      by: ["conversationId"],
      where: { userId, conversationId: { not: null } },
      _sum: { totalTokens: true, estimatedCost: true },
      _count: true,
      orderBy: { _sum: { totalTokens: "desc" } },
      take: 20,
    });

    // Get conversation titles
    const convIds = usages.map((u) => u.conversationId).filter((id): id is string => id !== null);
    const conversations = await prisma.conversation.findMany({
      where: { id: { in: convIds } },
      select: { id: true, title: true },
    });
    const titleMap = new Map(conversations.map((c) => [c.id, c.title]));

    return {
      conversations: usages.map((u) => ({
        conversationId: u.conversationId,
        title: titleMap.get(u.conversationId || "") || "Untitled",
        totalTokens: u._sum.totalTokens || 0,
        estimatedCost: Math.round((u._sum.estimatedCost || 0) * 10000) / 10000,
        messageCount: u._count,
      })),
    };
  });
}
