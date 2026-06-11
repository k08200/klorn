import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerTelegramCallback,
  isTelegramConfigured,
  redactBotToken,
  sendTelegramMessage,
} from "../telegram.js";

const TOKEN = "12345:AAFakeBotTokenForTests_abc-def";

function okFetch() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: {} }),
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
});

afterEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  vi.unstubAllGlobals();
});

describe("redactBotToken", () => {
  it("redacts the bot<token> URL segment", () => {
    const input = `request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`;
    const out = redactBotToken(input);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("bot<redacted>");
  });

  it("redacts the raw token even without the bot prefix", () => {
    const out = redactBotToken(`token=${TOKEN} rejected`);
    expect(out).not.toContain(TOKEN);
  });

  it("leaves unrelated text untouched", () => {
    expect(redactBotToken("plain error")).toBe("plain error");
  });
});

describe("isTelegramConfigured", () => {
  it("is true when TELEGRAM_BOT_TOKEN is set", () => {
    expect(isTelegramConfigured()).toBe(true);
  });

  it("is false when TELEGRAM_BOT_TOKEN is missing", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(isTelegramConfigured()).toBe(false);
  });
});

describe("sendTelegramMessage", () => {
  it("POSTs to the Bot API sendMessage endpoint with chat_id and text", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTelegramMessage("777", "hello");
    expect(result.ok).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchMock).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(init.body as string);
    expect(body.chat_id).toBe("777");
    expect(body.text).toBe("hello");
    expect(body.reply_markup).toBeUndefined();
  });

  it("includes an inline keyboard when provided", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await sendTelegramMessage("777", "hello", {
      inlineKeyboard: [[{ text: "Open Klorn", url: "https://app.example/inbox" }]],
    });

    const [, init] = vi.mocked(fetchMock).mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.reply_markup.inline_keyboard[0][0].text).toBe("Open Klorn");
  });

  it("returns ok:false without calling fetch when the token is missing", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTelegramMessage("777", "hello");
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws on network errors and redacts the token from the description", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/sendMessage`);
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTelegramMessage("777", "hello");
    expect(result.ok).toBe(false);
    expect(result.description).toBeTruthy();
    expect(result.description).not.toContain(TOKEN);
  });

  it("returns ok:false on a Bot API error response, with redacted description", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: "Bad Request: chat not found" }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTelegramMessage("777", "hello");
    expect(result.ok).toBe(false);
    expect(result.description).toContain("chat not found");
    expect(result.description).not.toContain(TOKEN);
  });
});

describe("answerTelegramCallback", () => {
  it("POSTs to answerCallbackQuery with the callback id and text", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const result = await answerTelegramCallback("cb-1", "Moved to Queue.");
    expect(result.ok).toBe(true);

    const [url, init] = vi.mocked(fetchMock).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`);
    const body = JSON.parse(init.body as string);
    expect(body.callback_query_id).toBe("cb-1");
    expect(body.text).toBe("Moved to Queue.");
  });
});
