/**
 * telegram-chat — a linked Telegram chat as a chat surface for the SAME
 * locked chat engine as the in-app assistant. Fire-and-forget from the
 * webhook, so everything here replies best-effort and never throws. Gates
 * before any LLM spend: link, dedupe, length, paywall posture
 * (requireAppAccess mirror), per-user turn budget.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindUnique = vi.hoisted(() => vi.fn(async () => ({ plan: "FREE", role: "USER" })));
const convFindFirst = vi.hoisted(() => vi.fn(async () => null as unknown));
const convCreate = vi.hoisted(() => vi.fn(async () => ({ id: "conv-1" })));
const convUpdate = vi.hoisted(() => vi.fn(async () => ({})));
const msgCreate = vi.hoisted(() => vi.fn(async () => ({})));
const msgFindMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const runChatTurnMock = vi.hoisted(() =>
  vi.fn(
    async () => ({ reply: "Here are your emails.", eventDraft: null }) as Record<string, unknown>,
  ),
);
const sendMessage = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const findUserId = vi.hoisted(() => vi.fn(async () => "u1" as string | null));
const isHardPaywalledMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("../db.js", () => {
  const prisma = {
    user: { findUnique: userFindUnique },
    conversation: { findFirst: convFindFirst, create: convCreate, update: convUpdate },
    message: { create: msgCreate, findMany: msgFindMany },
  };
  return { prisma, db: prisma };
});
vi.mock("../agentcore/chat-engine.js", () => ({ runChatTurn: runChatTurnMock }));
vi.mock("../notify/telegram.js", () => ({ sendTelegramMessage: sendMessage }));
vi.mock("../notify/telegram-link.js", () => ({ findUserIdByTelegramChatId: findUserId }));
vi.mock("../notify/notification-strings.js", () => ({
  getUserNotificationLanguage: vi.fn(async () => "en"),
}));
vi.mock("../billing/stripe.js", () => ({ isHardPaywalled: isHardPaywalledMock }));
vi.mock("../config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config.js")>();
  return { ...original, PAYWALL_ENABLED: true };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { __resetDedupForTests } from "../agentcore/agent-dedup.js";
import {
  __resetTelegramChatBudgetForTests,
  chunkTelegramReply,
  handleTelegramChatMessage,
} from "../agentcore/telegram-chat.js";

let nextUpdateId = 1000;
function msg(text: string, updateId: number = nextUpdateId++) {
  return { chatId: "chat-1", text, updateId };
}

beforeEach(() => {
  __resetDedupForTests();
  __resetTelegramChatBudgetForTests();
  userFindUnique.mockClear();
  userFindUnique.mockResolvedValue({ plan: "FREE", role: "USER" });
  convFindFirst.mockReset();
  convFindFirst.mockResolvedValue(null);
  convCreate.mockClear();
  msgCreate.mockClear();
  msgFindMany.mockReset();
  msgFindMany.mockResolvedValue([]);
  runChatTurnMock.mockClear();
  runChatTurnMock.mockResolvedValue({ reply: "Here are your emails.", eventDraft: null });
  sendMessage.mockClear();
  findUserId.mockReset();
  findUserId.mockResolvedValue("u1");
  isHardPaywalledMock.mockReturnValue(false);
});

describe("handleTelegramChatMessage", () => {
  it("sends a link hint (and no LLM turn) for an unlinked chat", async () => {
    findUserId.mockResolvedValue(null);
    await handleTelegramChatMessage(msg("show my inbox"));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(runChatTurnMock).not.toHaveBeenCalled();
  });

  it("runs a chat turn and persists both sides in a telegram conversation", async () => {
    await handleTelegramChatMessage(msg("what's urgent today?"));
    expect(convCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: "u1", source: "telegram" }),
      }),
    );
    expect(runChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", userText: "what's urgent today?" }),
    );
    expect(msgCreate).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith("chat-1", "Here are your emails.");
  });

  it("stores the daily-cap code on the assistant message, like the in-app chat", async () => {
    const cap = "You've used today's free AI quota. It resets at 00:00 UTC.";
    runChatTurnMock.mockResolvedValue({
      reply: cap,
      eventDraft: null,
      error: cap,
      errorCode: "DAILY_COST_CAP_FREE",
    });
    await handleTelegramChatMessage(msg("anything new?"));
    expect(msgCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: "ASSISTANT",
          metadata: expect.objectContaining({ turnErrorCode: "DAILY_COST_CAP_FREE" }),
        }),
      }),
    );
  });

  it("reuses an existing telegram conversation", async () => {
    convFindFirst.mockResolvedValue({ id: "conv-old", title: "t" });
    await handleTelegramChatMessage(msg("hi"));
    expect(convCreate).not.toHaveBeenCalled();
  });

  it("ignores empty text and refuses oversized text without an LLM call", async () => {
    await handleTelegramChatMessage(msg("   "));
    expect(sendMessage).not.toHaveBeenCalled();
    await handleTelegramChatMessage(msg("x".repeat(4001)));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(runChatTurnMock).not.toHaveBeenCalled();
  });

  it("dedupes a redelivered update_id", async () => {
    await handleTelegramChatMessage(msg("once", 42));
    await handleTelegramChatMessage(msg("once", 42));
    expect(runChatTurnMock).toHaveBeenCalledTimes(1);
  });

  it("enforces the per-user turn budget with a notice", async () => {
    for (let i = 0; i < 10; i++) {
      await handleTelegramChatMessage(msg(`q${i}`));
    }
    expect(runChatTurnMock).toHaveBeenCalledTimes(10);
    sendMessage.mockClear();
    await handleTelegramChatMessage(msg("one more"));
    expect(runChatTurnMock).toHaveBeenCalledTimes(10);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("mirrors requireAppAccess: hard-paywalled users get a notice, no turn", async () => {
    isHardPaywalledMock.mockReturnValue(true);
    await handleTelegramChatMessage(msg("hello"));
    expect(runChatTurnMock).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("appends an in-app confirmation note when the turn returns an event draft", async () => {
    runChatTurnMock.mockResolvedValue({
      reply: "Drafted it.",
      eventDraft: {
        title: "Sync",
        startTime: "2026-08-28T10:00:00Z",
        endTime: "2026-08-28T11:00:00Z",
      },
    });
    await handleTelegramChatMessage(msg("meet at 10"));
    const sent = sendMessage.mock.calls[0][1] as string;
    expect(sent.startsWith("Drafted it.")).toBe(true);
    expect(sent.length).toBeGreaterThan("Drafted it.".length);
  });

  it("chunks a long reply into multiple sends", async () => {
    runChatTurnMock.mockResolvedValue({ reply: "a".repeat(8000), eventDraft: null });
    await handleTelegramChatMessage(msg("long"));
    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe("chunkTelegramReply", () => {
  it("returns one chunk for short text and splits long text under the cap", () => {
    expect(chunkTelegramReply("hello")).toEqual(["hello"]);
    const chunks = chunkTelegramReply(`${"a".repeat(3000)}\n${"b".repeat(3000)}`);
    expect(chunks.length).toBe(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3900);
    }
  });
});

describe("notice send gate", () => {
  it("sends the unlinked notice at most once per window for a flooding chat", async () => {
    findUserId.mockResolvedValue(null);
    await handleTelegramChatMessage(msg("a"));
    await handleTelegramChatMessage(msg("b"));
    await handleTelegramChatMessage(msg("c"));
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("sends the rate-limited notice once, then stays silent within the window", async () => {
    for (let i = 0; i < 10; i++) {
      await handleTelegramChatMessage(msg(`q${i}`));
    }
    sendMessage.mockClear();
    await handleTelegramChatMessage(msg("over-1"));
    await handleTelegramChatMessage(msg("over-2"));
    await handleTelegramChatMessage(msg("over-3"));
    expect(runChatTurnMock).toHaveBeenCalledTimes(10);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("conversation creation race", () => {
  it("serializes concurrent first messages into ONE telegram conversation", async () => {
    // findFirst honors what create has done, like the real DB would once the
    // calls are serialized; unserialized, both callers would see null.
    convFindFirst.mockImplementation(async () =>
      convCreate.mock.calls.length > 0 ? { id: "conv-1", title: "t" } : null,
    );
    await Promise.all([
      handleTelegramChatMessage(msg("first")),
      handleTelegramChatMessage(msg("second")),
    ]);
    expect(convCreate).toHaveBeenCalledTimes(1);
  });
});
