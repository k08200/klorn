import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

vi.mock("../db.js", () => {
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })),
    },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});

vi.mock("../telegram.js", () => ({
  isTelegramConfigured: vi.fn(() => true),
  sendTelegramMessage: vi.fn(async () => ({ ok: true })),
  answerTelegramCallback: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../telegram-link.js", () => ({
  createTelegramLinkCode: vi.fn(async () => ({
    code: "test-code-123",
    expiresAt: new Date("2026-06-12T00:10:00Z"),
    deepLink: "https://t.me/klorn_test_bot?start=test-code-123",
  })),
  consumeTelegramLinkCode: vi.fn(async () => ({ linked: true })),
  unlinkTelegram: vi.fn(async () => {}),
  getLinkedTelegramChatId: vi.fn(async () => null),
  findUserIdByTelegramChatId: vi.fn(async () => null),
}));

vi.mock("../attention-override.js", () => ({
  overrideAttentionTier: vi.fn(async () => ({ ok: true, tier: "QUEUE" })),
}));

import { overrideAttentionTier } from "../attention-override.js";
import { answerTelegramCallback, isTelegramConfigured, sendTelegramMessage } from "../telegram.js";
import {
  consumeTelegramLinkCode,
  findUserIdByTelegramChatId,
  getLinkedTelegramChatId,
  unlinkTelegram,
} from "../telegram-link.js";

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

const WEBHOOK_SECRET = "webhook-secret-for-tests";
const secretHeader = (value: string = WEBHOOK_SECRET) => ({
  "x-telegram-bot-api-secret-token": value,
});

async function buildApp() {
  const { telegramRoutes } = await import("../routes/telegram.js");
  const app = Fastify();
  await app.register(telegramRoutes, { prefix: "/api/telegram" });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

afterEach(() => {
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
});

describe("GET /api/telegram/link", () => {
  it("requires authentication", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/telegram/link" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns linked:false when no chat is bound", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/telegram/link", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ linked: false });
    expect(getLinkedTelegramChatId).toHaveBeenCalledWith("user-1");
    await app.close();
  });

  it("returns linked:true without leaking the chat id", async () => {
    vi.mocked(getLinkedTelegramChatId).mockResolvedValueOnce("777");
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/telegram/link", headers: auth() });
    expect(res.statusCode).toBe(200);
    // Strict equality: the response must be the boolean flag and nothing else.
    expect(res.json()).toEqual({ linked: true });
    expect(res.body).not.toContain("777");
    await app.close();
  });
});

describe("POST /api/telegram/link", () => {
  it("requires authentication", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/telegram/link" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 503 when the bot token is not configured", async () => {
    vi.mocked(isTelegramConfigured).mockReturnValueOnce(false);
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/telegram/link", headers: auth() });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("mints a one-time code and the bot deep link", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/telegram/link", headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code).toBe("test-code-123");
    expect(body.deepLink).toBe("https://t.me/klorn_test_bot?start=test-code-123");
    expect(body.expiresAt).toBe("2026-06-12T00:10:00.000Z");
    await app.close();
  });
});

describe("DELETE /api/telegram/link", () => {
  it("requires authentication", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/telegram/link" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("unlinks the chat", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/telegram/link", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ linked: false });
    expect(unlinkTelegram).toHaveBeenCalledWith("user-1");
    await app.close();
  });
});

describe("POST /api/telegram/webhook — secret verification (CASA baseline)", () => {
  it("returns 503 when TELEGRAM_WEBHOOK_SECRET is not set", async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/telegram/webhook",
      headers: secretHeader(),
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("returns 401 when the secret header is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/telegram/webhook", payload: {} });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 401 when the secret header is wrong", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/telegram/webhook",
      headers: secretHeader("wrong-secret"),
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(consumeTelegramLinkCode).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("POST /api/telegram/webhook — /start linking", () => {
  it("binds the chat on /start with a valid code and confirms in chat", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/telegram/webhook",
      headers: secretHeader(),
      payload: { message: { text: "/start valid-code", chat: { id: 777 } } },
    });
    expect(res.statusCode).toBe(200);
    expect(consumeTelegramLinkCode).toHaveBeenCalledWith("valid-code", "777");
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = vi.mocked(sendTelegramMessage).mock.calls[0];
    expect(chatId).toBe("777");
    expect(text).toMatch(/linked/i);
    await app.close();
  });

  it("replies with an error for an invalid or expired code (still 200)", async () => {
    vi.mocked(consumeTelegramLinkCode).mockResolvedValueOnce({ linked: false });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/telegram/webhook",
      headers: secretHeader(),
      payload: { message: { text: "/start expired-code", chat: { id: 777 } } },
    });
    expect(res.statusCode).toBe(200);
    const [, text] = vi.mocked(sendTelegramMessage).mock.calls[0];
    expect(text).toMatch(/invalid or expired/i);
    await app.close();
  });

  it("ignores non-command messages (200, no side effects)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/telegram/webhook",
      headers: secretHeader(),
      payload: { message: { text: "hello bot", chat: { id: 777 } } },
    });
    expect(res.statusCode).toBe(200);
    expect(consumeTelegramLinkCode).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("POST /api/telegram/webhook — callback_query tier override", () => {
  it("applies the override when the chat is linked and answers the callback", async () => {
    vi.mocked(findUserIdByTelegramChatId).mockResolvedValueOnce("user-1");
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/telegram/webhook",
      headers: secretHeader(),
      payload: {
        callback_query: {
          id: "cb-1",
          data: "ovr:QUEUE:0b8e7a1c-1111-2222-3333-444455556666",
          message: { chat: { id: 777 } },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(overrideAttentionTier).toHaveBeenCalledWith(
      "user-1",
      "0b8e7a1c-1111-2222-3333-444455556666",
      "QUEUE",
    );
    expect(answerTelegramCallback).toHaveBeenCalledWith("cb-1", expect.stringMatching(/queue/i));
    await app.close();
  });

  it("applies SILENT overrides", async () => {
    vi.mocked(findUserIdByTelegramChatId).mockResolvedValueOnce("user-1");
    vi.mocked(overrideAttentionTier).mockResolvedValueOnce({ ok: true, tier: "SILENT" });
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/telegram/webhook",
      headers: secretHeader(),
      payload: {
        callback_query: { id: "cb-2", data: "ovr:SILENT:item-9", message: { chat: { id: 777 } } },
      },
    });
    expect(overrideAttentionTier).toHaveBeenCalledWith("user-1", "item-9", "SILENT");
    await app.close();
  });

  it("rejects callbacks from unlinked chats without touching any item", async () => {
    vi.mocked(findUserIdByTelegramChatId).mockResolvedValueOnce(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/telegram/webhook",
      headers: secretHeader(),
      payload: {
        callback_query: { id: "cb-3", data: "ovr:QUEUE:item-1", message: { chat: { id: 999 } } },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(overrideAttentionTier).not.toHaveBeenCalled();
    expect(answerTelegramCallback).toHaveBeenCalledWith(
      "cb-3",
      expect.stringMatching(/not linked/i),
    );
    await app.close();
  });

  it("ignores malformed callback data (no PUSH/AUTO escalation via crafted data)", async () => {
    vi.mocked(findUserIdByTelegramChatId).mockResolvedValueOnce("user-1");
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/telegram/webhook",
      headers: secretHeader(),
      payload: {
        callback_query: { id: "cb-4", data: "ovr:AUTO:item-1", message: { chat: { id: 777 } } },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(overrideAttentionTier).not.toHaveBeenCalled();
    await app.close();
  });

  it("tells the user when the item no longer exists", async () => {
    vi.mocked(findUserIdByTelegramChatId).mockResolvedValueOnce("user-1");
    vi.mocked(overrideAttentionTier).mockResolvedValueOnce({ ok: false, reason: "not_found" });
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/telegram/webhook",
      headers: secretHeader(),
      payload: {
        callback_query: { id: "cb-5", data: "ovr:QUEUE:gone-item", message: { chat: { id: 777 } } },
      },
    });
    expect(answerTelegramCallback).toHaveBeenCalledWith(
      "cb-5",
      expect.stringMatching(/not found/i),
    );
    await app.close();
  });

  it("returns 200 even when a handler throws (Telegram retries non-2xx)", async () => {
    vi.mocked(findUserIdByTelegramChatId).mockRejectedValueOnce(new Error("db down"));
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/telegram/webhook",
      headers: secretHeader(),
      payload: {
        callback_query: { id: "cb-6", data: "ovr:QUEUE:item-1", message: { chat: { id: 777 } } },
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
