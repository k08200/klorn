/**
 * Attention Receipt API
 *
 * "What did Klorn do (or not do) on my behalf today?"
 *
 * GET /api/inbox/receipt/today
 *   Returns a structured daily receipt:
 *   - silenced:  items that were seen but intentionally not surfaced
 *   - queued:    items placed in the inbox (no push)
 *   - pushed:    items that triggered a push notification
 *   - auto:      items that were auto-handled without asking the user
 *   - summary:   aggregate counts + narrative
 *
 * This is how EVE/Klorn builds trust: not by showing what it did,
 * but by being transparent about what it *didn't* interrupt you with.
 *
 * The receipt is derived from:
 *   - AttentionItem (tier field) for the current day
 *   - PushDeliveryLog for push outcomes
 *   - PendingAction (EXECUTED) for auto-handled items
 *   - EmailProcessingLog for silenced email signals
 */

import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { prisma } from "../db.js";

interface ReceiptItem {
  id: string;
  title: string;
  source: string;
  type: string;
  tierReason: string | null;
  surfacedAt: string;
  // For pushed items: push delivery outcome
  pushStatus?: string;
  pushClickedAt?: string | null;
}

interface DailyReceipt {
  date: string; // YYYY-MM-DD in user's timezone
  silenced: ReceiptItem[];
  queued: ReceiptItem[];
  pushed: ReceiptItem[];
  called: ReceiptItem[];
  auto: ReceiptItem[];
  summary: {
    totalSeen: number; // signals EVE evaluated
    totalInterrupted: number; // push + called + pending that user saw
    savedFromInbox: number; // silenced (would have been noise)
    autoHandled: number; // executed without asking
    narrative: string; // 1-2 sentence human summary
  };
}

export async function receiptRoutes(app: FastifyInstance) {
  app.get("/today", { preHandler: requireAuth }, async (request): Promise<DailyReceipt> => {
    const userId = getUserId(request);

    // Determine today's date window in user's timezone
    const config = await prisma.automationConfig.findUnique({
      where: { userId },
      select: { timezone: true },
    });
    const tz = config?.timezone || "UTC";
    const { todayStart, todayEnd } = getTodayWindow(tz);

    // Fetch all AttentionItems surfaced today
    const attentionItems = await (
      prisma.attentionItem as unknown as {
        findMany: (args: unknown) => Promise<
          Array<{
            id: string;
            title: string;
            source: string;
            type: string;
            tier: string | null;
            tierReason: string | null;
            surfacedAt: Date;
          }>
        >;
      }
    ).findMany({
      where: {
        userId,
        surfacedAt: { gte: todayStart, lt: todayEnd },
      },
      select: {
        id: true,
        title: true,
        source: true,
        type: true,
        tier: true,
        tierReason: true,
        surfacedAt: true,
      },
      orderBy: { surfacedAt: "asc" },
    });

    // Fetch push delivery logs for today to correlate outcomes
    const pushLogs = await prisma.pushDeliveryLog.findMany({
      where: { userId, createdAt: { gte: todayStart, lt: todayEnd } },
      select: { notificationId: true, status: true, clickedAt: true },
    });
    const pushByNotifId = new Map(pushLogs.map((p) => [p.notificationId, p]));

    // Fetch auto-executed pending actions today (no user prompt)
    const autoActions = await prisma.pendingAction.findMany({
      where: {
        userId,
        status: "EXECUTED",
        updatedAt: { gte: todayStart, lt: todayEnd },
      },
      select: { id: true, toolName: true, reasoning: true, updatedAt: true },
      orderBy: { updatedAt: "asc" },
    });

    // Fetch silenced email processing logs (SHADOW mode)
    const shadowLogs = await prisma.emailProcessingLog.findMany({
      where: {
        userId,
        mode: "SHADOW",
        processedAt: { gte: todayStart, lt: todayEnd },
      },
      select: { id: true, emailId: true, action: true, processedAt: true },
      take: 50,
    });

    // Categorize attention items by tier
    const silenced: ReceiptItem[] = [];
    const queued: ReceiptItem[] = [];
    const pushed: ReceiptItem[] = [];
    const called: ReceiptItem[] = [];

    for (const item of attentionItems) {
      const base: ReceiptItem = {
        id: item.id,
        title: item.title,
        source: item.source,
        type: item.type,
        tierReason: item.tierReason,
        surfacedAt: item.surfacedAt.toISOString(),
      };

      const tier = item.tier || "QUEUE";
      if (tier === "SILENT") {
        silenced.push(base);
      } else if (tier === "PUSH" || tier === "CALL") {
        // Find matching push log
        const push = pushLogs.find((p) => pushByNotifId.has(p.notificationId ?? ""));
        const enriched = {
          ...base,
          pushStatus: push?.status ?? "SENT",
          pushClickedAt: push?.clickedAt?.toISOString() ?? null,
        };
        if (tier === "CALL") {
          called.push(enriched);
        } else {
          pushed.push(enriched);
        }
      } else {
        queued.push(base);
      }
    }

    // AUTO items from pending actions
    const auto: ReceiptItem[] = autoActions.map((a) => ({
      id: a.id,
      title: a.reasoning?.slice(0, 80) ?? a.toolName.replace(/_/g, " "),
      source: "PENDING_ACTION",
      type: "DECISION",
      tierReason: "Auto-executed — low risk, pre-approved",
      surfacedAt: a.updatedAt.toISOString(),
    }));

    // Silent email signals
    const silencedEmails: ReceiptItem[] = shadowLogs.map((l) => ({
      id: l.id,
      title: `Email signal (${l.action})`,
      source: "EMAIL",
      type: "REPLY_NEEDED",
      tierReason: "Observed in SHADOW mode — not surfaced yet",
      surfacedAt: l.processedAt.toISOString(),
    }));

    const allSilenced = [...silenced, ...silencedEmails];
    const totalSeen = attentionItems.length + shadowLogs.length;
    const totalInterrupted = pushed.length + called.length;
    const autoHandled = auto.length;
    const savedFromInbox = allSilenced.length;

    const narrative = buildNarrative(totalSeen, totalInterrupted, savedFromInbox, autoHandled);

    return {
      date: todayStart.toISOString().slice(0, 10),
      silenced: allSilenced,
      queued,
      pushed,
      called,
      auto,
      summary: {
        totalSeen,
        totalInterrupted,
        savedFromInbox,
        autoHandled,
        narrative,
      },
    };
  });

  // Mark an auto-handled item for undo (surfaces a new PendingAction to reverse it)
  app.post(
    "/undo/:pendingActionId",
    { preHandler: requireAuth },
    async (request): Promise<{ ok: boolean; message: string }> => {
      const userId = getUserId(request);
      const { pendingActionId } = request.params as { pendingActionId: string };

      const action = await prisma.pendingAction.findFirst({
        where: { id: pendingActionId, userId, status: "EXECUTED" },
        select: { id: true, toolName: true, toolArgs: true, conversationId: true },
      });

      if (!action) {
        return { ok: false, message: "Action not found or already undone." };
      }

      // Create a reverse proposal in the same conversation
      const undoMessage = await prisma.message.create({
        data: {
          conversationId: action.conversationId,
          role: "ASSISTANT",
          content: `You requested an undo for the action: **${action.toolName.replace(/_/g, " ")}**. Tap Approve to reverse it.`,
          metadata: { source: "agent", hasAction: true },
        },
      });

      await prisma.pendingAction.create({
        data: {
          conversationId: action.conversationId,
          messageId: undoMessage.id,
          userId,
          toolName: `undo_${action.toolName}`,
          // Reuse the original toolArgs payload verbatim; cast through
          // Prisma.InputJsonValue because the read type is JsonValue
          // (includes JsonNull) while writes need InputJsonValue.
          toolArgs: (action.toolArgs ?? {}) as Prisma.InputJsonValue,
          reasoning: `Undo requested for: ${action.toolName.replace(/_/g, " ")}`,
        },
      });

      return { ok: true, message: "Undo proposal created — check your inbox." };
    },
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getTodayWindow(timezone: string): { todayStart: Date; todayEnd: Date } {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, dateStyle: "short" });
    const localDateStr = formatter.format(now); // YYYY-MM-DD
    const todayStart = new Date(`${localDateStr}T00:00:00`);
    const todayEnd = new Date(`${localDateStr}T23:59:59.999`);
    // Convert local midnight to UTC
    const offset = now.getTime() - Date.parse(now.toLocaleString("en-US", { timeZone: timezone }));
    return {
      todayStart: new Date(todayStart.getTime() + offset),
      todayEnd: new Date(todayEnd.getTime() + offset),
    };
  } catch {
    // Fallback to UTC day
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayEnd = new Date(now);
    todayEnd.setUTCHours(23, 59, 59, 999);
    return { todayStart, todayEnd };
  }
}

function buildNarrative(
  totalSeen: number,
  interrupted: number,
  silenced: number,
  autoHandled: number,
): string {
  const parts: string[] = [];

  if (totalSeen === 0) {
    return "No signals were processed today yet.";
  }

  parts.push(`Klorn evaluated ${totalSeen} signal${totalSeen !== 1 ? "s" : ""} today.`);

  if (silenced > 0) {
    parts.push(
      `${silenced} ${silenced === 1 ? "item was" : "items were"} silenced to protect your focus.`,
    );
  }

  if (interrupted > 0) {
    parts.push(
      `${interrupted} ${interrupted === 1 ? "push was" : "pushes were"} sent — only what mattered.`,
    );
  } else {
    parts.push("No pushes were sent — nothing was urgent enough.");
  }

  if (autoHandled > 0) {
    parts.push(
      `${autoHandled} low-risk ${autoHandled === 1 ? "action was" : "actions were"} handled automatically.`,
    );
  }

  return parts.join(" ");
}
