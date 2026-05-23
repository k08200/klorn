import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const createCompletionMock = vi.hoisted(() =>
  vi.fn(() => ({ choices: [{ message: { content: "Title" } }] })),
);
const getFeedbackPolicyContextForPromptMock = vi.hoisted(() =>
  vi.fn(
    async () =>
      "\n\n## Learned Feedback Policy Signals\n- avoid low-confidence send_email proposals.",
  ),
);

vi.mock("../email.js", () => ({ sendVerificationEmail: vi.fn(), sendPasswordResetEmail: vi.fn() }));
vi.mock("../gmail.js", () => ({
  getAuthUrl: vi.fn(),
  getLoginAuthUrl: vi.fn(),
  getAuthedClient: vi.fn(),
  getGoogleUserInfo: vi.fn(),
  getOAuth2Client: vi.fn(),
}));
vi.mock("../openai.js", () => ({
  CHAT_SYSTEM_PROMPT: "You are Eve",
  MODEL: "gpt-4o-mini",
  openai: {
    chat: {
      completions: {
        create: vi.fn(async () => ({ choices: [{ message: { content: "Title" } }] })),
      },
    },
  },
  createCompletion: createCompletionMock,
}));
vi.mock("../context-compressor.js", () => ({
  compactHistory: vi.fn(async (_id: string, msgs: unknown[]) => msgs),
  forceCompact: vi.fn(async () => []),
  isTokenLimitError: vi.fn(() => false),
}));
vi.mock("../memory.js", () => ({ loadMemoriesForPrompt: vi.fn(async () => "") }));
vi.mock("../policy-extraction.js", () => ({
  getFeedbackPolicyContextForPrompt: getFeedbackPolicyContextForPromptMock,
}));
vi.mock("../push.js", () => ({ sendPushNotification: vi.fn() }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../tool-executor.js", () => ({
  getToolsForPlan: vi.fn(() => []),
  isToolAllowedForPlan: vi.fn(() => true),
  executeToolCall: vi.fn(async () => "done"),
}));
vi.mock("../with-retry.js", () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

type Conv = {
  id: string;
  userId: string;
  title: string | null;
  pinned: boolean;
  updatedAt: Date;
  createdAt: Date;
  messages: Msg[];
};
type Msg = {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: Date;
  conversation?: { userId: string };
};
type Reminder = {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  remindAt: Date;
};
type PendingAction = {
  id: string;
  conversationId: string;
  messageId: string;
  userId: string;
  status: "PENDING" | "REJECTED" | "EXECUTED" | "FAILED";
  toolName: string;
  toolArgs: string;
  reasoning: string | null;
  result: string | null;
  createdAt: Date;
  updatedAt: Date;
};
const convStore = new Map<string, Conv>();
const msgStore = new Map<string, Msg>();
const reminderStore = new Map<string, Reminder>();
const pendingActionStore = new Map<string, PendingAction>();
let nextConvId = 1;
let nextMsgId = 1;
let nextReminderId = 1;
let nextActionId = 1;

vi.mock("../db.js", () => {
  const prisma = {
    conversation: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `conv-${nextConvId++}`;
        const conv: Conv = {
          id,
          userId: data.userId as string,
          title: (data.title as string) || null,
          pinned: false,
          updatedAt: new Date(),
          createdAt: new Date(),
          messages: [],
        };
        convStore.set(id, conv);
        return conv;
      }),
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const r: Conv[] = [];
        for (const c of convStore.values())
          if (c.userId === where.userId) r.push({ ...c, _count: { messages: c.messages.length } });
        return r;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => convStore.get(where.id) ?? null,
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const c = convStore.get(where.id);
          if (!c) throw new Error("Not found");
          const u = { ...c, ...data };
          convStore.set(where.id, u as Conv);
          return u;
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => convStore.delete(where.id)),
    },
    message: {
      create: vi.fn(
        async ({ data }: { data: { conversationId: string; role: string; content: string } }) => {
          const id = `msg-${nextMsgId++}`;
          const msg: Msg = { id, ...data, createdAt: new Date() };
          msgStore.set(id, msg);
          const conv = convStore.get(data.conversationId);
          if (conv) conv.messages.push(msg);
          return msg;
        },
      ),
      count: vi.fn(async () => 0),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const msg = msgStore.get(where.id);
        if (!msg) return null;
        const conv = convStore.get(msg.conversationId);
        return { ...msg, conversation: { userId: conv?.userId || "" } };
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => msgStore.delete(where.id)),
      deleteMany: vi.fn(async () => ({})),
    },
    userToken: { findFirst: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })) },
    reminder: {
      create: vi.fn(
        ({
          data,
        }: {
          data: { userId: string; title: string; description?: string | null; remindAt: Date };
        }) => {
          const id = `reminder-${nextReminderId++}`;
          const reminder: Reminder = {
            id,
            userId: data.userId,
            title: data.title,
            description: data.description ?? null,
            remindAt: data.remindAt,
          };
          reminderStore.set(id, reminder);
          return reminder;
        },
      ),
      findMany: vi.fn(async () => []),
    },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
    attentionItem: {
      upsert: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  const db = {
    ...prisma,
    pendingAction: {
      groupBy: vi.fn(async () => []),
      create: vi.fn(
        ({
          data,
        }: {
          data: {
            conversationId: string;
            messageId: string;
            userId: string;
            toolName: string;
            toolArgs: string;
            reasoning?: string | null;
          };
        }) => {
          const id = `action-${nextActionId++}`;
          const action: PendingAction = {
            id,
            conversationId: data.conversationId,
            messageId: data.messageId,
            userId: data.userId,
            status: "PENDING",
            toolName: data.toolName,
            toolArgs: data.toolArgs,
            reasoning: data.reasoning ?? null,
            result: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          pendingActionStore.set(id, action);
          return action;
        },
      ),
      findMany: vi.fn(({ where }: { where?: { conversationId?: string } } = {}) =>
        [...pendingActionStore.values()].filter(
          (action) => !where?.conversationId || action.conversationId === where.conversationId,
        ),
      ),
      deleteMany: vi.fn(async () => ({})),
    },
    conversationSummary: { deleteMany: vi.fn(async () => ({})) },
    tokenUsage: {
      aggregate: vi.fn(async () => ({ _sum: { totalTokens: 0 } })),
      create: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({})),
    },
  };
  return { prisma, db };
});

vi.mock("../stripe.js", () => ({
  getEffectivePlan: vi.fn(() => ({
    name: "FREE",
    messageLimit: 50,
    tokenLimit: 100000,
    deviceLimit: 3,
  })),
}));

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const OTHER = signToken({ userId: "user-2", email: "o@e.com" });
const auth = (t = TOKEN) => ({ authorization: `Bearer ${t}` });

async function buildApp() {
  const { chatRoutes } = await import("../routes/chat.js");
  const app = Fastify();
  await app.register(chatRoutes, { prefix: "/api/chat" });
  return app;
}

function resetStores() {
  convStore.clear();
  msgStore.clear();
  reminderStore.clear();
  pendingActionStore.clear();
  nextConvId = 1;
  nextMsgId = 1;
  nextReminderId = 1;
  nextActionId = 1;
  createCompletionMock.mockReset();
  createCompletionMock.mockResolvedValue({ choices: [{ message: { content: "Title" } }] });
  getFeedbackPolicyContextForPromptMock.mockClear();
  getFeedbackPolicyContextForPromptMock.mockResolvedValue(
    "\n\n## Learned Feedback Policy Signals\n- avoid low-confidence send_email proposals.",
  );
}

describe("chat routes (conversation CRUD)", () => {
  beforeEach(resetStores);

  it("rejects unauthenticated with 401", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/api/chat/conversations" })).statusCode).toBe(
      401,
    );
    await app.close();
  });

  // POST /conversations
  it("creates a conversation", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth(),
      payload: { title: "My Chat" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().title).toBe("My Chat");
    await app.close();
  });

  it("creates conversation with initial message", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth(),
      payload: { initialMessage: "Hello Eve" },
    });
    expect(res.statusCode).toBe(201);
    const conv = convStore.get(res.json().id);
    expect(conv?.messages).toHaveLength(1);
    expect(conv?.messages[0].content).toBe("Hello Eve");
    await app.close();
  });

  it("rejects conversation creation with empty title", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth(),
      payload: { title: "   " },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects conversation creation with invalid title type", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth(),
      payload: { title: { bad: true } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  // GET /conversations
  it("lists conversations", async () => {
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth(),
      payload: { title: "C1" },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/chat/conversations",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversations).toHaveLength(1);
    await app.close();
  });

  // GET /conversations/:id
  it("gets conversation by id", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth(),
      payload: { title: "Mine" },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/chat/conversations/${c.json().id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("returns 403 for other user's conversation", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth(),
      payload: { title: "Mine" },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/chat/conversations/${c.json().id}`,
      headers: auth(OTHER),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("returns 404 for non-existent conversation", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/chat/conversations/non-existent",
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  // PATCH /conversations/:id
  it("updates conversation title", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth(),
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/chat/conversations/${c.json().id}`,
      headers: auth(),
      payload: { title: "New Title" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe("New Title");
    await app.close();
  });

  it("rejects updating conversation with empty title", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth(),
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/chat/conversations/${c.json().id}`,
      headers: auth(),
      payload: { title: "   " },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects updating conversation with invalid pinned type", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth(),
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/chat/conversations/${c.json().id}`,
      headers: auth(),
      payload: { pinned: "yes" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  // DELETE /conversations/:id
  it("deletes own conversation", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth(),
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/chat/conversations/${c.json().id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("returns 403 when deleting other user's conversation", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth(),
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/chat/conversations/${c.json().id}`,
      headers: auth(OTHER),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  // DELETE /messages/:msgId
  it("deletes own message", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth(),
      payload: { initialMessage: "Test msg" },
    });
    const conv = convStore.get(c.json().id)!;
    const msgId = conv.messages[0].id;

    const res = await app.inject({
      method: "DELETE",
      url: `/api/chat/messages/${msgId}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("returns 403 when deleting other user's message", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth(),
      payload: { initialMessage: "My msg" },
    });
    const conv = convStore.get(c.json().id)!;
    const msgId = conv.messages[0].id;

    const res = await app.inject({
      method: "DELETE",
      url: `/api/chat/messages/${msgId}`,
      headers: auth(OTHER),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("rejects sending an empty chat message", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth(),
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${c.json().id}/messages`,
      headers: auth(),
      payload: { content: "   " },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects sending a chat message with invalid content type", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth(),
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${c.json().id}/messages`,
      headers: auth(),
      payload: { content: { bad: true } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("turns chat propose_action tool calls into pending approval cards", async () => {
    const { getToolsForPlan } = await import("../tool-executor.js");
    vi.mocked(getToolsForPlan).mockReturnValue([
      {
        type: "function",
        function: {
          name: "create_task",
          description: "Create a task",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
    ]);
    createCompletionMock.mockImplementation((input: { tools?: unknown[] }) => {
      if (input.tools) {
        return {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    function: {
                      name: "propose_action",
                      arguments: JSON.stringify({
                        message:
                          "📋 상황: 운영 루프에서 지난 태스크가 확인됐어요.\n💡 판단: 오늘 처리 순서를 정해야 해요.\n✅ 제안: '운영 루프 후속 정리' 태스크를 만들어드릴까요?",
                        toolName: "create_task",
                        toolArgs: { title: "운영 루프 후속 정리", priority: "HIGH" },
                        priority: "high",
                        category: "task",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        };
      }
      return { choices: [{ message: { content: "Title" } }] };
    });

    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth(),
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${c.json().id}/messages`,
      headers: auth(),
      payload: { content: "이걸 승인 가능한 결정 카드로 만들어줘" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("운영 루프 후속 정리");
    expect(pendingActionStore.size).toBe(1);
    const action = [...pendingActionStore.values()][0];
    expect(action.toolName).toBe("create_task");
    // toolArgs is JSONB post-#332 — assert the parsed shape rather
    // than the legacy stringified form.
    expect(JSON.stringify(action.toolArgs)).toContain("운영 루프 후속 정리");
    expect(msgStore.get(action.messageId)?.content).toContain("✅ 제안");
    await app.close();
  });

  it("includes learned feedback policy context in chat prompts", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth(),
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${c.json().id}/messages`,
      headers: auth(),
      payload: { content: "오늘 제안할 것 있어?" },
    });

    expect(res.statusCode).toBe(200);
    const toolCall = createCompletionMock.mock.calls.find(([input]) =>
      Boolean((input as { tools?: unknown[] }).tools),
    )?.[0] as { messages: Array<{ role: string; content: string }> } | undefined;
    expect(toolCall?.messages[0].content).toContain("Learned Feedback Policy Signals");
    expect(toolCall?.messages[0].content).toContain("avoid low-confidence send_email proposals");
    expect(getFeedbackPolicyContextForPromptMock).toHaveBeenCalledWith("user-1");
    await app.close();
  });

  it("creates clear relative reminder requests without waiting for LLM tool calling", async () => {
    const app = await buildApp();
    const c = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: auth(),
    });

    const before = Date.now();
    const res = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${c.json().id}/messages`,
      headers: auth(),
      payload: { content: "1분 뒤에 테스트 알림 보내줘" },
    });

    expect(res.statusCode).toBe(200);
    expect(reminderStore.size).toBe(1);
    const reminder = [...reminderStore.values()][0];
    expect(reminder.title).toBe("테스트");
    expect(reminder.remindAt.getTime()).toBeGreaterThanOrEqual(before + 55_000);
    expect(res.body).toContain("I will remind you");
    await app.close();
  });
});
