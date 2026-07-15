import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => {
  const prisma = {
    user: {
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
    },
  };
  return { prisma, db: prisma };
});

import { prisma } from "../db.js";
import {
  consumeTelegramLinkCode,
  createTelegramLinkCode,
  getLinkedTelegramChatId,
  TELEGRAM_LINK_CODE_TTL_MS,
  unlinkTelegram,
} from "../notify/telegram-link.js";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.TELEGRAM_BOT_USERNAME;
});

describe("createTelegramLinkCode", () => {
  it("stores a crypto-random code with a 10-minute expiry", async () => {
    const now = new Date("2026-06-12T00:00:00Z");
    const { code, expiresAt } = await createTelegramLinkCode("user-1", now);

    // /start payload charset: A-Za-z0-9_- only, and long enough to resist guessing
    expect(code).toMatch(/^[A-Za-z0-9_-]{10,64}$/);
    expect(expiresAt.getTime()).toBe(now.getTime() + TELEGRAM_LINK_CODE_TTL_MS);
    expect(TELEGRAM_LINK_CODE_TTL_MS).toBe(10 * 60 * 1000);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { telegramLinkCode: code, telegramLinkCodeExpiresAt: expiresAt },
    });
  });

  it("generates a fresh code every call", async () => {
    const a = await createTelegramLinkCode("user-1");
    const b = await createTelegramLinkCode("user-1");
    expect(a.code).not.toBe(b.code);
  });

  it("builds the t.me deep link from TELEGRAM_BOT_USERNAME", async () => {
    process.env.TELEGRAM_BOT_USERNAME = "klorn_test_bot";
    const { code, deepLink } = await createTelegramLinkCode("user-1");
    expect(deepLink).toBe(`https://t.me/klorn_test_bot?start=${code}`);
  });

  it("returns a null deep link when the bot username is not configured", async () => {
    const { deepLink } = await createTelegramLinkCode("user-1");
    expect(deepLink).toBeNull();
  });
});

describe("consumeTelegramLinkCode", () => {
  it("binds the chat id and clears the code when the code is valid", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({ id: "user-1" } as never);

    const result = await consumeTelegramLinkCode("valid-code", "777");
    expect(result.linked).toBe(true);

    // Any other user holding this chat id is unbound first (chat id is unique)
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { telegramChatId: "777" },
      data: { telegramChatId: null },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        telegramChatId: "777",
        telegramLinkCode: null,
        telegramLinkCodeExpiresAt: null,
      },
    });
  });

  it("only matches codes that have not expired", async () => {
    const now = new Date("2026-06-12T00:00:00Z");
    await consumeTelegramLinkCode("some-code", "777", now);

    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { telegramLinkCode: "some-code", telegramLinkCodeExpiresAt: { gt: now } },
      select: { id: true },
    });
  });

  it("rejects an unknown or expired code without mutating anything", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null);

    const result = await consumeTelegramLinkCode("expired-code", "777");
    expect(result.linked).toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an empty code without touching the DB", async () => {
    const result = await consumeTelegramLinkCode("", "777");
    expect(result.linked).toBe(false);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });
});

describe("unlinkTelegram", () => {
  it("clears the chat id and any pending link code", async () => {
    await unlinkTelegram("user-1");
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        telegramChatId: null,
        telegramLinkCode: null,
        telegramLinkCodeExpiresAt: null,
      },
    });
  });
});

describe("getLinkedTelegramChatId", () => {
  it("returns the linked chat id", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ telegramChatId: "777" } as never);
    expect(await getLinkedTelegramChatId("user-1")).toBe("777");
  });

  it("returns null when nothing is linked", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ telegramChatId: null } as never);
    expect(await getLinkedTelegramChatId("user-1")).toBeNull();
  });
});
