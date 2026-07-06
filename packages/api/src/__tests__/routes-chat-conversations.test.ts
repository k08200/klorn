import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

// The chat conversation surface: free-tier accessible (requireAppAccess, not
// requireEntitled), strictly userId-scoped (no IDOR), one LLM turn per POST.

const runChatTurn = vi.fn(async () => ({
  reply: "assistant says hi",
  eventDraft: null as unknown,
}));
vi.mock("../chat-engine.js", () => ({
  runChatTurn: (...args: unknown[]) => runChatTurn(...args),
}));

const requireAppAccess = vi.fn(async () => {});
vi.mock("../entitlement-guard.js", () => ({
  requireAppAccess: (...args: unknown[]) => requireAppAccess(...args),
}));

const conversationFindMany = vi.fn(async () => []);
const conversationFindFirst = vi.fn(async (): Promise<unknown> => null);
const conversationCreate = vi.fn(async () => ({
  id: "conv-1",
  title: null,
  updatedAt: new Date(),
}));
const conversationUpdate = vi.fn(async () => ({}));
const messageFindMany = vi.fn(async () => [] as unknown[]);
const messageCreate = vi.fn(async () => ({ id: "msg-1" }));

vi.mock("../db.js", () => {
  const prisma = {
    // requireAuth session checks: a valid device row + no global revocation.
    user: {
      findUnique: vi.fn(async () => ({ id: "user-1", sessionsInvalidatedAt: null })),
    },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      update: vi.fn(async () => ({})),
    },
    conversation: {
      findMany: (...a: unknown[]) => conversationFindMany(...a),
      findFirst: (...a: unknown[]) => conversationFindFirst(...a),
      create: (...a: unknown[]) => conversationCreate(...a),
      update: (...a: unknown[]) => conversationUpdate(...a),
    },
    message: {
      findMany: (...a: unknown[]) => messageFindMany(...a),
      create: (...a: unknown[]) => messageCreate(...a),
    },
  };
  return { prisma, db: prisma };
});

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

async function buildApp() {
  const { chatConversationRoutes } = await import("../routes/chat-conversations.js");
  const app = Fastify();
  await app.register(chatConversationRoutes, { prefix: "/api/chat" });
  return app;
}

beforeEach(() => {
  runChatTurn.mockClear();
  requireAppAccess.mockClear();
  conversationFindMany.mockClear();
  conversationFindFirst.mockReset();
  conversationFindFirst.mockResolvedValue(null);
  conversationCreate.mockClear();
  conversationUpdate.mockClear();
  messageFindMany.mockClear();
  messageCreate.mockClear();
});

describe("chat conversation routes", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/chat/conversations" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("wires requireAppAccess (free tier allowed, hard paywall respected)", async () => {
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/api/chat/conversations", headers: auth() });
    expect(requireAppAccess).toHaveBeenCalled();
    await app.close();
  });

  it("lists only the caller's chat conversations", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/chat/conversations",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(conversationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-1", source: "chat" }),
      }),
    );
    await app.close();
  });

  it("creates a chat conversation owned by the caller", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "conv-1" });
    expect(conversationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: "user-1", source: "chat" }),
      }),
    );
    await app.close();
  });

  it("404s messages of a conversation the caller does not own (IDOR)", async () => {
    conversationFindFirst.mockResolvedValue(null); // scoped lookup finds nothing
    const app = await buildApp();

    const get = await app.inject({
      method: "GET",
      url: "/api/chat/conversations/other-users-conv/messages",
      headers: auth(),
    });
    expect(get.statusCode).toBe(404);

    const post = await app.inject({
      method: "POST",
      url: "/api/chat/conversations/other-users-conv/messages",
      headers: auth(),
      payload: { text: "hi" },
    });
    expect(post.statusCode).toBe(404);
    expect(runChatTurn).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects empty or oversized text with 400", async () => {
    conversationFindFirst.mockResolvedValue({ id: "conv-1", userId: "user-1", title: "t" });
    const app = await buildApp();

    for (const payload of [{}, { text: "" }, { text: "   " }, { text: "x".repeat(4001) }]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/chat/conversations/conv-1/messages",
        headers: auth(),
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    expect(runChatTurn).not.toHaveBeenCalled();
    await app.close();
  });

  it("runs a turn: persists both messages and returns reply + eventDraft", async () => {
    conversationFindFirst.mockResolvedValue({ id: "conv-1", userId: "user-1", title: null });
    // findMany is called with orderBy createdAt DESC — newest first.
    messageFindMany.mockResolvedValue([
      { role: "ASSISTANT", content: "earlier answer" },
      { role: "USER", content: "earlier question" },
    ]);
    const draft = {
      title: "김대표 미팅",
      startTime: "2026-07-07T15:00:00+09:00",
      endTime: "2026-07-07T16:00:00+09:00",
    };
    runChatTurn.mockResolvedValueOnce({ reply: "카드를 확인해 주세요.", eventDraft: draft });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/conversations/conv-1/messages",
      headers: auth(),
      payload: { text: "내일 3시 김대표 미팅" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ reply: "카드를 확인해 주세요.", eventDraft: draft });

    // history handed to the engine uses lowercase roles
    expect(runChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        userText: "내일 3시 김대표 미팅",
        history: [
          { role: "user", content: "earlier question" },
          { role: "assistant", content: "earlier answer" },
        ],
      }),
    );

    // user message + assistant message persisted
    expect(messageCreate).toHaveBeenCalledTimes(2);
    const assistantCall = messageCreate.mock.calls[1]?.[0] as {
      data: { role: string; metadata: Record<string, unknown> };
    };
    expect(assistantCall.data.role).toBe("ASSISTANT");
    expect(assistantCall.data.metadata).toMatchObject({ source: "chat", eventDraft: draft });

    // first message titles the conversation
    expect(conversationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "conv-1" },
        data: expect.objectContaining({ title: expect.stringContaining("김대표") }),
      }),
    );
    await app.close();
  });

  it("still answers 200 with the engine's honest error reply", async () => {
    conversationFindFirst.mockResolvedValue({ id: "conv-1", userId: "user-1", title: "t" });
    runChatTurn.mockResolvedValueOnce({
      reply: "Sorry — I couldn't process that right now. Please try again in a moment.",
      eventDraft: null,
      error: "provider down",
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/conversations/conv-1/messages",
      headers: auth(),
      payload: { text: "hi" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ error: "provider down" });
    await app.close();
  });
});
