/**
 * User-initiated chat conversations — the interactive assistant surface.
 *
 * Rebuilt 2026-07-06 (the original /chat surface was dropped for POC scope in
 * #424/#427). One POST = one LLM turn through the Klorn-scoped chat engine
 * (see chat-engine.ts for the tool lockdown). Free tier is admitted
 * (requireAppAccess); calendar writes stay behind POST /api/calendar's
 * requireEntitled — chat only ever produces drafts.
 */

import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { runChatTurn } from "../chat-engine.js";
import { prisma } from "../db.js";
import { requireAppAccess } from "../entitlement-guard.js";

const MAX_TEXT_LENGTH = 4000;
const HISTORY_LIMIT = 20;
const CONVERSATION_LIST_LIMIT = 30;
const MESSAGE_LIST_LIMIT = 100;
const TITLE_LENGTH = 60;

export async function chatConversationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireAppAccess);

  app.get("/conversations", async (request) => {
    const userId = getUserId(request);
    const conversations = await prisma.conversation.findMany({
      where: { userId, source: "chat" },
      orderBy: { updatedAt: "desc" },
      take: CONVERSATION_LIST_LIMIT,
      select: { id: true, title: true, updatedAt: true },
    });
    return { conversations };
  });

  app.post("/conversations", async (request) => {
    const userId = getUserId(request);
    const conversation = await prisma.conversation.create({
      data: { userId, source: "chat" },
      select: { id: true, title: true, updatedAt: true },
    });
    return conversation;
  });

  app.get("/conversations/:id/messages", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };

    const conversation = await prisma.conversation.findFirst({ where: { id, userId } });
    if (!conversation) return reply.code(404).send({ error: "Conversation not found" });

    const messages = await prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: "asc" },
      take: MESSAGE_LIST_LIMIT,
      select: { id: true, role: true, content: true, metadata: true, createdAt: true },
    });
    return { messages };
  });

  app.post("/conversations/:id/messages", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { text?: unknown };

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return reply.code(400).send({ error: "text is required" });
    if (text.length > MAX_TEXT_LENGTH) {
      return reply.code(400).send({ error: `text must be at most ${MAX_TEXT_LENGTH} characters` });
    }

    const conversation = await prisma.conversation.findFirst({ where: { id, userId } });
    if (!conversation) return reply.code(404).send({ error: "Conversation not found" });

    // History BEFORE persisting the new user message, so the turn's prompt
    // carries the prior thread and the new text exactly once.
    const priorMessages = await prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: "desc" },
      take: HISTORY_LIMIT,
      select: { role: true, content: true },
    });
    const history = [...priorMessages]
      .reverse()
      .filter((m) => m.role === "USER" || m.role === "ASSISTANT")
      .map((m) => ({
        role: m.role === "USER" ? ("user" as const) : ("assistant" as const),
        content: m.content,
      }));

    await prisma.message.create({
      data: {
        conversationId: id,
        role: "USER",
        content: text,
        metadata: { source: "chat" },
      },
    });

    const result = await runChatTurn({ userId, history, userText: text });

    await prisma.message.create({
      data: {
        conversationId: id,
        role: "ASSISTANT",
        content: result.reply,
        metadata: {
          source: "chat",
          ...(result.eventDraft ? { eventDraft: result.eventDraft } : {}),
          ...(result.error ? { turnError: result.error } : {}),
        },
      },
    });

    await prisma.conversation.update({
      where: { id },
      data: {
        updatedAt: new Date(),
        ...(conversation.title ? {} : { title: text.slice(0, TITLE_LENGTH) }),
      },
    });

    return {
      reply: result.reply,
      eventDraft: result.eventDraft,
      ...(result.error ? { error: result.error } : {}),
    };
  });
}
