import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import type OpenAI from "openai";
import { resolveActionTarget } from "../action-target.js";
import { AGENT_SYSTEM_PROMPT, PROPOSE_ACTION_TOOL } from "../agent/prompt.js";
import { isHousekeepingProposalToolName } from "../agent-logic.js";
import {
  deleteAttentionForPendingActions,
  upsertAttentionForPendingAction,
} from "../attention-mirror.js";
import { getUserId, requireAuth } from "../auth.js";
import { extractAndUpsertCommitmentsFromText } from "../commitment-ingestion.js";
import { compactHistory, forceCompact, isTokenLimitError } from "../context-compressor.js";
import { db, prisma } from "../db.js";
import { extractSnippet } from "../extract-snippet.js";
import { recipientFromToolArgs, recordFeedback } from "../feedback.js";
import { getUserLlmCredentials } from "../llm-credentials.js";
import { loadMemoriesForPrompt } from "../memory.js";
import { estimateModelCostUsd } from "../model-fallback.js";
import { createCompletion, MODEL } from "../openai.js";
import { getFeedbackPolicyContextForPrompt } from "../policy-extraction.js";
import { scheduleReminderDeliveryCheck } from "../reminder-scheduler.js";
import { createReminder } from "../reminders.js";
import { Semaphore } from "../semaphore.js";
import { captureError } from "../sentry.js";
import { getEffectivePlan } from "../stripe.js";
import { executeToolCall, getToolsForPlan } from "../tool-executor.js";

/** Shared semaphore for chat tool execution — limits concurrent tool calls per request */
const chatToolSemaphore = new Semaphore(5);

import { pushNotification } from "../websocket.js";
import { withRetry } from "../with-retry.js";
import { registerChatPendingActionsRoutes } from "./chat-pending-actions.js";

/** Auto-generate conversation title from the first user message (fire-and-forget) */
async function autoGenerateTitle(conversationId: string, userMessage: string) {
  try {
    const convo = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    // Only generate if title is null/empty (never been set)
    if (convo?.title) return;

    const response = await createCompletion(
      {
        model: MODEL,
        messages: [
          {
            role: "system",
            content:
              "Generate a short conversation title (max 30 chars) from the user message. Reply with ONLY the title, no quotes or extra text. Use the same language as the user message.",
          },
          { role: "user", content: userMessage },
        ],
        max_tokens: 50,
      },
      { userId: convo?.userId },
    );

    const title = response.choices[0]?.message?.content?.trim();
    if (title) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { title: title.slice(0, 60) },
      });
    }
  } catch {
    // Title generation is non-critical, silently fail
  }
}

export const idParamSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1 },
  },
} as const;

const messageIdParamSchema = {
  type: "object",
  additionalProperties: false,
  required: ["msgId"],
  properties: {
    msgId: { type: "string", minLength: 1 },
  },
} as const;

export const actionIdParamSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actionId"],
  properties: {
    actionId: { type: "string", minLength: 1 },
  },
} as const;

const createConversationBodySchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120 },
        initialMessage: { type: "string", minLength: 1, maxLength: 10000 },
      },
    },
    { type: "null" },
  ],
} as const;

const updateConversationBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120 },
    pinned: { type: "boolean" },
  },
} as const;

const searchQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    q: { type: "string", maxLength: 200 },
  },
} as const;

const sendMessageBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["content"],
  properties: {
    content: { type: "string", minLength: 1, maxLength: 20000 },
  },
} as const;

export const rejectActionBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reason: { type: "string", minLength: 1, maxLength: 500 },
  },
} as const;

export function hasMeaningfulText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function coerceRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

async function createPendingActionFromProposal(input: {
  userId: string;
  conversationId: string;
  allowedToolNames: Set<string>;
  args: Record<string, unknown>;
}): Promise<{ message: string; messageId: string; actionId: string }> {
  const message = typeof input.args.message === "string" ? input.args.message.trim() : "";
  const toolName = typeof input.args.toolName === "string" ? input.args.toolName.trim() : "";
  if (!message) throw new Error("propose_action.message is required");
  if (!toolName) throw new Error("propose_action.toolName is required");
  if (isHousekeepingProposalToolName(toolName)) {
    throw new Error("Housekeeping proposal tools are not approval actions");
  }
  if (!input.allowedToolNames.has(toolName)) {
    throw new Error(`Tool is not available for approval in this chat: ${toolName}`);
  }

  const toolArgs = coerceRecord(input.args.toolArgs);
  const assistantMsg = await db.message.create({
    data: {
      conversationId: input.conversationId,
      role: "ASSISTANT",
      content: message,
      metadata: { source: "chat", hasAction: true },
    },
  });

  const pendingAction = await db.pendingAction.create({
    data: {
      conversationId: input.conversationId,
      messageId: assistantMsg.id,
      userId: input.userId,
      toolName,
      // JSONB after migration 20260519060000.
      toolArgs: (toolArgs ?? {}) as Prisma.InputJsonValue,
      reasoning: message,
    },
  });
  await upsertAttentionForPendingAction(pendingAction);
  await prisma.conversation.update({
    where: { id: input.conversationId },
    data: { updatedAt: new Date() },
  });

  pushNotification(input.userId, {
    id: "pending-action-created",
    type: "system",
    title: "conversations-updated",
    message: "",
    createdAt: new Date().toISOString(),
  });

  return {
    message,
    messageId: assistantMsg.id,
    actionId: (pendingAction as { id: string }).id,
  };
}

function writeChunkedToken(write: (payload: string) => void, content: string) {
  const chunkSize = 20;
  for (let i = 0; i < content.length; i += chunkSize) {
    write(
      `data: ${JSON.stringify({ type: "token", content: content.slice(i, i + chunkSize) })}\n\n`,
    );
  }
}

function extractCommitmentsFromUserMessage(
  userId: string,
  conversationId: string,
  messageId: string,
  content: string,
) {
  extractAndUpsertCommitmentsFromText({
    userId,
    sourceType: "CHAT",
    sourceId: messageId,
    threadId: conversationId,
    text: content,
    contextTitle: "Chat message",
  }).catch((err) => {
    captureError(err, {
      tags: { scope: "commitment.chat_ingestion" },
      extra: { userId, conversationId, messageId },
    });
  });
}

type DirectReminderRequest = {
  title: string;
  remindAt: Date;
};

function parseDirectReminderRequest(
  content: string,
  now = new Date(),
): DirectReminderRequest | null {
  const normalized = content.trim();
  if (!/(알림|알려줘|리마인더|리마인드|remind)/i.test(normalized)) return null;

  const relative = normalized.match(
    /([0-9]{1,3})(?:[ \t]{0,8})(분|시간|일)(?:[ \t]{0,8})(뒤에|후에|뒤|후|있다가)/,
  );
  if (!relative) return null;

  const amount = Number.parseInt(relative[1] ?? "", 10);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = relative[2];
  const multiplier = unit === "분" ? 60_000 : unit === "시간" ? 60 * 60_000 : 24 * 60 * 60_000;
  const remindAt = new Date(now.getTime() + amount * multiplier);

  const title =
    normalized
      .replace(relative[0], "")
      .replace(/(뒤에|후에|뒤|후|있다가)/g, "")
      .replace(/(알림|알려줘|보내줘|설정해줘|리마인더|리마인드|해줘|줘|remind me|remind)/gi, "")
      .replace(/^[에\s]+/, "")
      .replace(/\s+/g, " ")
      .trim() || "Test reminder";

  return { title, remindAt };
}

export function chatRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // Sub-route group: pending actions (approval surface). Registers against
  // the same /api/chat prefix so client paths stay byte-identical.
  registerChatPendingActionsRoutes(app);

  // POST /api/chat/conversations — Create new conversation
  // Optional body: { title?: string, initialMessage?: string }
  app.post(
    "/conversations",
    { schema: { body: createConversationBodySchema } },
    async (request, reply) => {
      const userId = getUserId(request);
      const body = (request.body || {}) as {
        title?: string;
        initialMessage?: string;
      };

      if (body.title !== undefined && !hasMeaningfulText(body.title)) {
        return reply.code(400).send({ error: "Title cannot be empty" });
      }
      if (body.initialMessage !== undefined && !hasMeaningfulText(body.initialMessage)) {
        return reply.code(400).send({ error: "Initial message cannot be empty" });
      }

      const conversation = await prisma.conversation.create({
        data: {
          userId,
          ...(body.title ? { title: body.title.trim() } : {}),
        },
      });

      // If initialMessage provided, create a user message and trigger auto-title
      if (body.initialMessage) {
        const initialMessage = body.initialMessage.trim();
        const initialMsg = await prisma.message.create({
          data: {
            conversationId: conversation.id,
            role: "USER",
            content: initialMessage,
          },
        });
        extractCommitmentsFromUserMessage(userId, conversation.id, initialMsg.id, initialMessage);
        if (!body.title) {
          autoGenerateTitle(conversation.id, initialMessage);
        }
      }

      return reply.code(201).send(conversation);
    },
  );

  // GET /api/chat/conversations — List conversations
  app.get("/conversations", async (request) => {
    const userId = getUserId(request);

    const where = { userId };
    const conversations = await prisma.conversation.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      include: {
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
        _count: { select: { messages: true } },
      },
    });

    // Attach pending action counts for agent-initiated conversations
    const agentConvIds = (conversations as Array<Record<string, unknown>>)
      .filter((c) => c.source === "agent")
      .map((c) => c.id as string);

    let pendingCounts: Record<string, number> = {};
    if (agentConvIds.length > 0) {
      const counts = await db.pendingAction.groupBy({
        by: ["conversationId"],
        where: { conversationId: { in: agentConvIds }, status: "PENDING" },
        _count: { id: true },
      });
      pendingCounts = Object.fromEntries(
        counts.map((c: { conversationId: string; _count: { id: number } }) => [
          c.conversationId,
          c._count.id,
        ]),
      );
    }

    const enriched = (conversations as Array<Record<string, unknown>>).map((c) => ({
      ...c,
      pendingActionCount: pendingCounts[c.id as string] || 0,
    }));

    return { conversations: enriched };
  });

  // GET /api/chat/conversations/:id — Get conversation with messages
  app.get("/conversations/:id", { schema: { params: idParamSchema } }, async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
      },
    });

    if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
    if (conversation.userId !== userId) return reply.code(403).send({ error: "Forbidden" });
    return conversation;
  });

  // PATCH /api/chat/conversations/:id — Update conversation (title, pinned)
  app.patch(
    "/conversations/:id",
    { schema: { params: idParamSchema, body: updateConversationBodySchema } },
    async (request, reply) => {
      const userId = getUserId(request);
      const { id } = request.params as { id: string };
      const body = request.body as { title?: string; pinned?: boolean };

      const conversation = await prisma.conversation.findUnique({
        where: { id },
      });
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      if (conversation.userId !== userId) return reply.code(403).send({ error: "Forbidden" });
      if (body.title !== undefined && !hasMeaningfulText(body.title)) {
        return reply.code(400).send({ error: "Title cannot be empty" });
      }

      const data: { title?: string; pinned?: boolean } = {};
      if (body.title !== undefined) data.title = body.title.trim();
      if (body.pinned !== undefined) data.pinned = body.pinned;

      const updated = await prisma.conversation.update({ where: { id }, data });
      return reply.send(updated);
    },
  );

  // DELETE /api/chat/conversations/:id
  app.delete(
    "/conversations/:id",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const userId = getUserId(request);
      const { id } = request.params as { id: string };

      const conversation = await prisma.conversation.findUnique({
        where: { id },
      });
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      if (conversation.userId !== userId) return reply.code(403).send({ error: "Forbidden" });

      // Explicit ordered deletion to avoid FK constraint violations
      // PendingAction has dual FK (conversationId + messageId) — must delete first
      const conversationPendingActions = await db.pendingAction.findMany({
        where: { conversationId: id },
        select: { id: true },
      });
      await db.pendingAction.deleteMany({ where: { conversationId: id } });
      await deleteAttentionForPendingActions(
        conversationPendingActions.map((p: { id: string }) => p.id),
      );
      await db.conversationSummary.deleteMany({
        where: { conversationId: id },
      });
      await db.tokenUsage.updateMany({
        where: { conversationId: id },
        data: { conversationId: null },
      });
      await prisma.message.deleteMany({ where: { conversationId: id } });
      await prisma.conversation.delete({ where: { id } });
      return reply.code(204).send();
    },
  );

  // GET /api/chat/conversations/:id/export — Export conversation as markdown
  app.get(
    "/conversations/:id/export",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const userId = getUserId(request);
      const { id } = request.params as { id: string };
      const convo = await prisma.conversation.findUnique({
        where: { id },
        include: { messages: { orderBy: { createdAt: "asc" } } },
      });
      if (!convo) return reply.code(404).send({ error: "Conversation not found" });
      if (convo.userId !== userId) return reply.code(403).send({ error: "Forbidden" });

      const title = convo.title || "Untitled Conversation";
      const date = convo.createdAt.toISOString().split("T")[0];
      let md = `# ${title}\n\n_Exported: ${date}_\n\n---\n\n`;

      for (const msg of convo.messages) {
        const role = msg.role === "USER" ? "You" : "Klorn";
        md += `**${role}** _(${new Date(msg.createdAt).toLocaleString("en-US")})_\n\n${msg.content}\n\n---\n\n`;
      }

      return reply
        .header("Content-Type", "text/markdown; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="klorn-chat-${date}.md"`)
        .send(md);
    },
  );

  // DELETE /api/chat/messages/:msgId — Delete a single message
  app.delete(
    "/messages/:msgId",
    { schema: { params: messageIdParamSchema } },
    async (request, reply) => {
      const userId = getUserId(request);
      const { msgId } = request.params as { msgId: string };
      try {
        const msg = await prisma.message.findUnique({
          where: { id: msgId },
          include: { conversation: { select: { userId: true } } },
        });
        if (!msg) return reply.code(404).send({ error: "Message not found" });
        if (msg.conversation.userId !== userId) return reply.code(403).send({ error: "Forbidden" });

        await prisma.message.delete({ where: { id: msgId } });
        return reply.code(204).send();
      } catch {
        return reply.code(404).send({ error: "Message not found" });
      }
    },
  );

  // POST /api/chat/conversations/:id/retry — Regenerate last assistant response
  app.post(
    "/conversations/:id/retry",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const userId = getUserId(request);
      const { id } = request.params as { id: string };

      const conversation = await prisma.conversation.findUnique({
        where: { id },
        include: { messages: { orderBy: { createdAt: "asc" } } },
      });

      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      if (conversation.userId !== userId) return reply.code(403).send({ error: "Forbidden" });

      // Find last user message
      const lastUserMsg = [...conversation.messages].reverse().find((m) => m.role === "USER");
      if (!lastUserMsg) return reply.code(400).send({ error: "No user message to retry" });

      // Delete the last assistant message if it exists
      const lastMsg = conversation.messages[conversation.messages.length - 1];
      if (lastMsg && lastMsg.role === "ASSISTANT") {
        await prisma.message.delete({ where: { id: lastMsg.id } });
      }

      // Build history up to (not including) the deleted assistant message
      const historyMessages = conversation.messages.filter(
        (m: { id: string; role: string }) =>
          !(lastMsg && lastMsg.role === "ASSISTANT" && m.id === lastMsg.id),
      );

      const [token, retryUser] = await Promise.all([
        prisma.userToken.findFirst({
          where: { userId: conversation.userId, provider: "google" },
        }),
        prisma.user.findUnique({ where: { id: conversation.userId } }),
      ]);
      const retryPlan = retryUser?.plan || "FREE";
      const retryBaseTools = getToolsForPlan(!!token, retryPlan);
      const retryAllowedToolNames = new Set(retryBaseTools.map((tool) => tool.function.name));
      const tools = [...retryBaseTools, PROPOSE_ACTION_TOOL];
      const retryChatModel = MODEL;
      const retryCredentials = await getUserLlmCredentials(conversation.userId);

      // Build dynamic context for retry
      const retryContextParts: string[] = [];
      try {
        const now = new Date();
        const kstTime = now.toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 16);
        retryContextParts.push(`Current time: ${kstTime} KST`);
        const pendingTasks = await prisma.task.findMany({
          where: { userId: conversation.userId, status: { not: "DONE" } },
          orderBy: { dueDate: "asc" },
          take: 5,
        });
        if (pendingTasks.length > 0) {
          const taskList = pendingTasks
            .map(
              (t: (typeof pendingTasks)[number]) =>
                `- ${t.title}${t.dueDate ? ` (due: ${t.dueDate.toLocaleDateString("en-US")})` : ""}${t.priority === "URGENT" || t.priority === "HIGH" ? ` [${t.priority}]` : ""}`,
            )
            .join("\n");
          retryContextParts.push(`Open tasks:\n${taskList}`);
        }
      } catch {
        // optional
      }
      const retryDynamicContext =
        retryContextParts.length > 0
          ? `\n\n[Current context]\n${retryContextParts.join("\n\n")}`
          : "";

      // Load user memories for retry too
      let retryMemoryContext = "";
      let retryPolicyContext = "";
      try {
        retryMemoryContext = await loadMemoriesForPrompt(conversation.userId);
      } catch {
        // optional
      }
      try {
        retryPolicyContext = await getFeedbackPolicyContextForPrompt(conversation.userId);
      } catch {
        // optional
      }

      const history = [
        {
          role: "system" as const,
          content:
            AGENT_SYSTEM_PROMPT + retryDynamicContext + retryMemoryContext + retryPolicyContext,
        },
        ...historyMessages.map((m: { role: string; content: string }) => ({
          role: m.role.toLowerCase() as "user" | "assistant",
          content: m.content,
        })),
      ];

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      let fullResponse = "";
      let retryClientDisconnected = false;

      // Keep the LLM running even if the user navigated away — the DB save
      // below still happens, so they see the full response when they return.
      request.raw.on("close", () => {
        retryClientDisconnected = true;
      });

      const retrySafeWrite = (payload: string) => {
        if (retryClientDisconnected) return;
        try {
          reply.raw.write(payload);
        } catch {
          retryClientDisconnected = true;
        }
      };

      let assistantMessagePersisted = false;
      try {
        if (tools.length > 0) {
          const messages: unknown[] = [...history];
          let maxIterations = 5;

          while (maxIterations-- > 0) {
            const response = await createCompletion(
              {
                model: retryChatModel,
                messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
                tools,
              },
              { credentials: retryCredentials, userId: conversation.userId },
            );

            const choice = response.choices[0];
            const toolCalls = choice.message.tool_calls;

            if (choice.finish_reason === "tool_calls" || (toolCalls && toolCalls.length > 0)) {
              messages.push(choice.message);
              const proposalCall = (toolCalls || []).find((toolCall) => {
                const fn = (
                  toolCall as unknown as {
                    function: { name: string };
                  }
                ).function;
                return fn.name === "propose_action";
              });
              if (proposalCall) {
                const fn = (
                  proposalCall as unknown as {
                    function: { name: string; arguments: string };
                  }
                ).function;
                const args = JSON.parse(fn.arguments || "{}") as Record<string, unknown>;
                retrySafeWrite(
                  `data: ${JSON.stringify({ type: "tool_call", name: fn.name, args })}\n\n`,
                );
                const proposal = await createPendingActionFromProposal({
                  userId: conversation.userId,
                  conversationId: id,
                  allowedToolNames: retryAllowedToolNames,
                  args,
                });
                fullResponse = proposal.message;
                assistantMessagePersisted = true;
                retrySafeWrite(
                  `data: ${JSON.stringify({ type: "tool_result", name: fn.name })}\n\n`,
                );
                writeChunkedToken(retrySafeWrite, fullResponse);
                break;
              }
              const results = await Promise.all(
                (toolCalls || []).map(async (toolCall) =>
                  chatToolSemaphore.run(async () => {
                    const fn = (
                      toolCall as unknown as {
                        function: { name: string; arguments: string };
                      }
                    ).function;
                    const args = JSON.parse(fn.arguments);
                    retrySafeWrite(
                      `data: ${JSON.stringify({ type: "tool_call", name: fn.name, args })}\n\n`,
                    );
                    const result = await executeToolCall(conversation.userId, fn.name, args);
                    retrySafeWrite(
                      `data: ${JSON.stringify({ type: "tool_result", name: fn.name })}\n\n`,
                    );
                    return { tool_call_id: toolCall.id, content: result };
                  }),
                ),
              );
              for (const r of results) {
                messages.push({
                  role: "tool",
                  tool_call_id: r.tool_call_id,
                  content: r.content,
                });
              }
            } else {
              fullResponse = choice.message.content || "";
              retrySafeWrite(
                `data: ${JSON.stringify({ type: "token", content: fullResponse })}\n\n`,
              );
              break;
            }
          }
        } else {
          const stream = await createCompletion(
            {
              model: retryChatModel,
              messages: history as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
              stream: true,
            },
            { credentials: retryCredentials, userId: conversation.userId },
          );
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) {
              fullResponse += delta;
              retrySafeWrite(`data: ${JSON.stringify({ type: "token", content: delta })}\n\n`);
            }
          }
        }

        if (fullResponse && !assistantMessagePersisted) {
          await prisma.message.create({
            data: {
              conversationId: id,
              role: "ASSISTANT",
              content: fullResponse,
            },
          });
        }

        await prisma.conversation.update({
          where: { id },
          data: { updatedAt: new Date() },
        });

        retrySafeWrite(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      } catch (err) {
        // Save partial response even if client disconnected
        if (fullResponse && !assistantMessagePersisted) {
          try {
            await prisma.message.create({
              data: {
                conversationId: id,
                role: "ASSISTANT",
                content: fullResponse,
              },
            });
          } catch {
            // DB save failed
          }
        }

        const message = err instanceof Error ? err.message : "Unknown error";
        retrySafeWrite(`data: ${JSON.stringify({ type: "error", content: message })}\n\n`);
      }

      try {
        reply.raw.end();
      } catch {
        // Client already disconnected
      }
    },
  );

  // GET /api/chat/search?q=keyword — Search across all conversations
  app.get("/search", { schema: { querystring: searchQuerySchema } }, async (request) => {
    const userId = getUserId(request);
    const { q } = request.query as { q?: string };
    if (!q || q.trim().length < 2) {
      return { results: [] };
    }

    const messages = await prisma.message.findMany({
      where: {
        conversation: { userId },
        content: { contains: q, mode: "insensitive" },
      },
      include: {
        conversation: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    return {
      results: messages.map((m: (typeof messages)[number]) => {
        const snippet = extractSnippet(m.content, q, 200);
        return {
          messageId: m.id,
          conversationId: m.conversation.id,
          conversationTitle: m.conversation.title || "Untitled",
          role: m.role,
          content: snippet.text,
          highlights: snippet.highlights,
          createdAt: m.createdAt,
        };
      }),
    };
  });

  // POST /api/chat/conversations/:id/messages — Send message + SSE streaming response
  app.post(
    "/conversations/:id/messages",
    { schema: { params: idParamSchema, body: sendMessageBodySchema } },
    async (request, reply) => {
      const userId = getUserId(request);
      const { id } = request.params as { id: string };
      const { content } = request.body as { content: string };
      if (!hasMeaningfulText(content)) {
        return reply.code(400).send({ error: "Message content cannot be empty" });
      }
      const trimmedContent = content.trim();

      // Verify conversation exists and belongs to user
      const conversation = await prisma.conversation.findUnique({
        where: { id },
        include: { messages: { orderBy: { createdAt: "asc" } } },
      });

      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      if (conversation.userId !== userId) return reply.code(403).send({ error: "Forbidden" });

      // Reject rapid duplicate submissions. A double-click or "the response
      // didn't come, let me retry" hammer fires N copies of the same prompt
      // through the LLM in seconds, which is the single biggest reason free
      // OpenRouter quota gets burned on this app. Compare against the most
      // recent USER message in this conversation.
      const lastUserMessage = [...conversation.messages]
        .reverse()
        .find((m: { role: string }) => m.role === "USER") as
        | { content: string; createdAt: Date }
        | undefined;
      if (
        lastUserMessage &&
        lastUserMessage.content === trimmedContent &&
        Date.now() - new Date(lastUserMessage.createdAt).getTime() < 2_000
      ) {
        return reply.code(429).send({
          error: "Duplicate message — wait a moment before sending the same prompt again.",
        });
      }

      // Check billing plan message limit (skip for demo-user)
      const user = await prisma.user.findUnique({
        where: { id: conversation.userId },
      });
      if (user && user.id !== "demo-user") {
        const planConfig = getEffectivePlan(user.plan, user.role);
        if (planConfig.messageLimit !== Infinity) {
          const now = new Date();
          const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
          const monthlyCount = await prisma.message.count({
            where: {
              conversation: { userId: user.id },
              role: "USER",
              createdAt: { gte: periodStart },
            },
          });
          if (monthlyCount >= planConfig.messageLimit) {
            return reply.code(402).send({
              error: "Message limit reached",
              plan: user.plan,
              messageLimit: planConfig.messageLimit,
              messageCount: monthlyCount,
            });
          }
        }

        // Check token limit
        if (planConfig.tokenLimit !== Infinity) {
          const now = new Date();
          const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
          const tokenAgg = await db.tokenUsage.aggregate({
            where: { userId: user.id, createdAt: { gte: periodStart } },
            _sum: { totalTokens: true },
          });
          const monthlyTokens = tokenAgg._sum.totalTokens || 0;
          if (monthlyTokens >= planConfig.tokenLimit) {
            return reply.code(402).send({
              error: "Token limit reached",
              plan: user.plan,
              tokenLimit: planConfig.tokenLimit,
              tokenUsage: monthlyTokens,
            });
          }
        }
      }

      const userChatModel = MODEL;
      const userCredentials = await getUserLlmCredentials(conversation.userId);

      // Save user message
      const savedUserMessage = await prisma.message.create({
        data: { conversationId: id, role: "USER", content: trimmedContent },
      });
      extractCommitmentsFromUserMessage(userId, id, savedUserMessage.id, trimmedContent);

      const directReminder = parseDirectReminderRequest(trimmedContent);
      if (directReminder) {
        const result = await createReminder(
          conversation.userId,
          directReminder.title,
          directReminder.remindAt.toISOString(),
        );
        const directTimerScheduled = scheduleReminderDeliveryCheck(
          result.reminder.id,
          new Date(result.reminder.remindAt),
        );
        console.log(
          `[REMINDER] Direct chat reminder created: ${result.reminder.id} remindAt=${result.reminder.remindAt} timer=${directTimerScheduled ? "scheduled" : "scheduler-only"}`,
        );
        const fullResponse = `I will remind you at ${directReminder.remindAt.toLocaleString(
          "en-US",
          {
            timeZone: "Asia/Seoul",
            hour: "2-digit",
            minute: "2-digit",
          },
        )} KST: "${result.reminder.title}".`;

        await prisma.message.create({
          data: {
            conversationId: id,
            role: "ASSISTANT",
            content: fullResponse,
          },
        });
        await prisma.conversation.update({
          where: { id },
          data: { updatedAt: new Date() },
        });

        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        reply.raw.write(`data: ${JSON.stringify({ type: "token", content: fullResponse })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        reply.raw.end();
        return;
      }

      // Quick fallback title from the raw user message; an LLM-generated
      // title replaces it via autoGenerateTitle() once the response stream
      // finishes (see end of handler). Doing both inline + post-stream
      // double-billed the LLM for every first message.
      if (!conversation.title && conversation.messages.length === 0) {
        const fallback =
          trimmedContent.length > 50 ? `${trimmedContent.slice(0, 50)}...` : trimmedContent;
        await prisma.conversation.update({
          where: { id },
          data: { title: fallback },
        });
      }

      // Check if Gmail is connected for this user
      const token = await prisma.userToken.findFirst({
        where: { userId: conversation.userId, provider: "google" },
      });
      const baseTools = getToolsForPlan(!!token, user?.plan || "FREE");
      const allowedToolNames = new Set(baseTools.map((tool) => tool.function.name));
      const tools = [...baseTools, PROPOSE_ACTION_TOOL];

      // Build dynamic context so Klorn knows the current situation.
      const contextParts: string[] = [];
      try {
        const now = new Date();
        const kstTime2 = now.toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 16);
        contextParts.push(`Current time: ${kstTime2} KST`);

        // Pending tasks
        const pendingTasks = await prisma.task.findMany({
          where: { userId: conversation.userId, status: { not: "DONE" } },
          orderBy: { dueDate: "asc" },
          take: 5,
        });
        if (pendingTasks.length > 0) {
          const taskList = pendingTasks
            .map(
              (t: (typeof pendingTasks)[number]) =>
                `- ${t.title}${t.dueDate ? ` (due: ${t.dueDate.toLocaleDateString("en-US")})` : ""}${t.priority === "URGENT" || t.priority === "HIGH" ? ` [${t.priority}]` : ""}`,
            )
            .join("\n");
          contextParts.push(`Open tasks:\n${taskList}`);
        }

        // Today's upcoming reminders
        // Get end of today in KST
        const kstNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
        const todayEnd = new Date(kstNow.getFullYear(), kstNow.getMonth(), kstNow.getDate() + 1);
        const upcomingReminders = await prisma.reminder.findMany({
          where: {
            userId: conversation.userId,
            status: "PENDING",
            remindAt: { lte: todayEnd },
          },
          take: 3,
        });
        if (upcomingReminders.length > 0) {
          const reminderList = upcomingReminders
            .map((r: (typeof upcomingReminders)[number]) => `- ${r.title}`)
            .join("\n");
          contextParts.push(`Today's reminders:\n${reminderList}`);
        }
      } catch {
        // Context loading is optional — don't break chat if it fails
      }

      const dynamicContext =
        contextParts.length > 0 ? `\n\n[Current context]\n${contextParts.join("\n\n")}` : "";

      // Load user memories for personalization (Claude Code memdir/ pattern)
      let memoryContext = "";
      let policyContext = "";
      try {
        memoryContext = await loadMemoriesForPrompt(conversation.userId);
      } catch {
        // Memory loading is optional
      }
      try {
        policyContext = await getFeedbackPolicyContextForPrompt(conversation.userId);
      } catch {
        // Feedback policy loading is optional
      }

      // Build message history with auto-compaction (Claude Code compact/ pattern).
      // On token-limit errors we rebuild with forceCompact and retry once, so
      // history is mutable.
      const rawMessages = conversation.messages as {
        id: string;
        role: string;
        content: string;
        createdAt: Date;
      }[];
      const buildHistory = async (force: boolean) => {
        const compacted = force
          ? await forceCompact(id, rawMessages)
          : await compactHistory(id, rawMessages);
        return [
          {
            role: "system" as const,
            content: AGENT_SYSTEM_PROMPT + dynamicContext + memoryContext + policyContext,
          },
          ...compacted,
          { role: "user" as const, content },
        ];
      };
      let history = await buildHistory(false);
      let compactionRetryUsed = false;

      // SSE headers
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      let fullResponse = "";
      let clientDisconnected = false;

      // Detect client disconnect — keep generating so the DB gets the full
      // response even if the user navigated away, but stop attempting to
      // write SSE frames (would throw EPIPE).
      request.raw.on("close", () => {
        clientDisconnected = true;
      });

      const safeWrite = (payload: string) => {
        if (clientDisconnected) return;
        try {
          reply.raw.write(payload);
        } catch {
          clientDisconnected = true;
        }
      };

      let assistantMessagePersisted = false;
      try {
        let apiUsage:
          | {
              prompt_tokens?: number;
              completion_tokens?: number;
              total_tokens?: number;
            }
          | undefined;

        if (tools.length > 0) {
          // Function calling loop with auto-retry (Claude Code withRetry pattern)
          let messages: unknown[] = [...history];
          let maxIterations = 5;

          console.log("[CHAT] Tools enabled, starting function calling loop");

          while (maxIterations-- > 0) {
            let response: OpenAI.Chat.Completions.ChatCompletion;
            try {
              response = await withRetry(
                () =>
                  createCompletion(
                    {
                      model: userChatModel,
                      messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
                      tools,
                    },
                    { credentials: userCredentials, userId: conversation.userId },
                  ),
                {
                  maxRetries: 2,
                  onRetry: (attempt, _err, delay) =>
                    console.log(`[CHAT] LLM retry #${attempt}, waiting ${delay}ms`),
                },
              );
            } catch (err) {
              // Context overflow on the first iteration — aggressively compact
              // the base history and restart the loop once. Later iterations
              // accumulate tool call/result state we can't safely drop, so we
              // only recover when messages still match the initial history.
              if (
                isTokenLimitError(err) &&
                !compactionRetryUsed &&
                messages.length === history.length
              ) {
                compactionRetryUsed = true;
                console.warn("[CHAT] token-limit error — forcing compaction and retrying once");
                history = await buildHistory(true);
                messages = [...history];
                maxIterations++;
                continue;
              }
              throw err;
            }

            const choice = response.choices[0];
            const toolCalls = choice.message.tool_calls;

            console.log(
              "[CHAT] finish_reason:",
              choice.finish_reason,
              "tool_calls:",
              toolCalls?.length || 0,
            );

            if (choice.finish_reason === "tool_calls" || (toolCalls && toolCalls.length > 0)) {
              messages.push(choice.message);
              const proposalCall = (toolCalls || []).find((toolCall) => {
                const fn = (
                  toolCall as unknown as {
                    function: { name: string };
                  }
                ).function;
                return fn.name === "propose_action";
              });
              if (proposalCall) {
                const fn = (
                  proposalCall as unknown as {
                    function: { name: string; arguments: string };
                  }
                ).function;
                const args = JSON.parse(fn.arguments || "{}") as Record<string, unknown>;

                safeWrite(
                  `data: ${JSON.stringify({ type: "tool_call", name: fn.name, args })}\n\n`,
                );

                const proposal = await createPendingActionFromProposal({
                  userId: conversation.userId,
                  conversationId: id,
                  allowedToolNames,
                  args,
                });
                fullResponse = proposal.message;
                assistantMessagePersisted = true;
                safeWrite(`data: ${JSON.stringify({ type: "tool_result", name: fn.name })}\n\n`);
                writeChunkedToken(safeWrite, fullResponse);
                break;
              }

              const results = await Promise.all(
                (toolCalls || []).map(async (toolCall) =>
                  chatToolSemaphore.run(async () => {
                    const fn = (
                      toolCall as unknown as {
                        function: { name: string; arguments: string };
                      }
                    ).function;
                    const args = JSON.parse(fn.arguments);

                    // Intentionally no debug log here — every value derived from the
                    // tool call (name, args, result) is user-controlled and CodeQL
                    // flags it as clear-text logging. The SSE event below already
                    // gives the client visibility into which tool ran.
                    safeWrite(
                      `data: ${JSON.stringify({ type: "tool_call", name: fn.name, args })}\n\n`,
                    );

                    const result = await executeToolCall(conversation.userId, fn.name, args);

                    safeWrite(
                      `data: ${JSON.stringify({ type: "tool_result", name: fn.name })}\n\n`,
                    );

                    return { tool_call_id: toolCall.id, content: result };
                  }),
                ),
              );

              for (const r of results) {
                messages.push({
                  role: "tool",
                  tool_call_id: r.tool_call_id,
                  content: r.content,
                });
              }
            } else {
              // Final response after tools — stream via SSE for better UX
              fullResponse = choice.message.content || "";
              if (response.usage) apiUsage = response.usage;
              console.log("[CHAT] Final response length:", fullResponse.length);

              // Stream final response in chunks for smoother rendering
              const chunkSize = 20;
              for (let i = 0; i < fullResponse.length; i += chunkSize) {
                const chunk = fullResponse.slice(i, i + chunkSize);
                safeWrite(`data: ${JSON.stringify({ type: "token", content: chunk })}\n\n`);
              }
              break;
            }
          }
        } else {
          // Regular streaming with auto-retry (no tools available)
          const openStream = () =>
            withRetry(
              () =>
                createCompletion(
                  {
                    model: userChatModel,
                    messages: history as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
                    stream: true,
                  },
                  { credentials: userCredentials, userId: conversation.userId },
                ),
              {
                maxRetries: 2,
                onRetry: (attempt, _err, delay) =>
                  console.log(`[CHAT] Stream retry #${attempt}, waiting ${delay}ms`),
              },
            );
          let stream: Awaited<ReturnType<typeof openStream>>;
          try {
            stream = await openStream();
          } catch (err) {
            if (isTokenLimitError(err) && !compactionRetryUsed) {
              compactionRetryUsed = true;
              console.warn(
                "[CHAT] stream token-limit error — forcing compaction and retrying once",
              );
              history = await buildHistory(true);
              stream = await openStream();
            } else {
              throw err;
            }
          }

          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) {
              fullResponse += delta;
              // Keep accumulating into fullResponse even if client is gone —
              // safeWrite no-ops when disconnected. The completed response is
              // persisted in the DB save below, so navigating away no longer
              // truncates the answer.
              safeWrite(`data: ${JSON.stringify({ type: "token", content: delta })}\n\n`);
            }
          }
        }

        // Save assistant message
        if (fullResponse && !assistantMessagePersisted) {
          await prisma.message.create({
            data: {
              conversationId: id,
              role: "ASSISTANT",
              content: fullResponse,
            },
          });
        }

        // Track token usage — use actual API usage when available, estimate for streaming
        const promptTokens =
          apiUsage?.prompt_tokens ??
          Math.ceil((history.reduce((sum, m) => sum + m.content.length, 0) + content.length) / 3);
        const completionTokens = apiUsage?.completion_tokens ?? Math.ceil(fullResponse.length / 3);
        const totalTokens = apiUsage?.total_tokens ?? promptTokens + completionTokens;
        db.tokenUsage
          .create({
            data: {
              userId: conversation.userId,
              conversationId: id,
              model: userChatModel,
              promptTokens,
              completionTokens,
              totalTokens,
              estimatedCost: estimateModelCostUsd(userChatModel, promptTokens, completionTokens),
            },
          })
          .catch(() => {
            // Token tracking is non-critical
          });

        // Update conversation timestamp
        await prisma.conversation.update({
          where: { id },
          data: { updatedAt: new Date() },
        });

        // Auto-generate title after first message (fire-and-forget)
        if (conversation.messages.length === 0) {
          autoGenerateTitle(id, trimmedContent);
        }

        safeWrite(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        // Persist whatever we have so refresh shows the same state instead of
        // a lonely USER bubble. If tokens did arrive, save those plus the error
        // marker; otherwise save just the error so the user knows the request
        // failed and stops re-sending the same prompt.
        try {
          if (fullResponse && !assistantMessagePersisted) {
            await prisma.message.create({
              data: {
                conversationId: id,
                role: "ASSISTANT",
                content: `${fullResponse}\n\n[Error: ${message}]`,
                metadata: { source: "chat", error: true, partial: true },
              },
            });
          } else if (!assistantMessagePersisted) {
            await prisma.message.create({
              data: {
                conversationId: id,
                role: "ASSISTANT",
                content: `[Error: ${message}]`,
                metadata: { source: "chat", error: true },
              },
            });
          }
          await prisma.conversation.update({
            where: { id },
            data: { updatedAt: new Date() },
          });
        } catch {
          // DB save failed — nothing we can do
        }

        safeWrite(`data: ${JSON.stringify({ type: "error", content: message })}\n\n`);
      }

      try {
        reply.raw.end();
      } catch {
        // Client already disconnected
      }
    },
  );
}
