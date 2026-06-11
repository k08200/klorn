import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../telegram.js", () => ({
  isTelegramConfigured: vi.fn(() => true),
  sendTelegramMessage: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../telegram-link.js", () => ({
  getLinkedTelegramChatId: vi.fn(async () => "777"),
}));
vi.mock("../sentry.js", () => ({
  captureError: vi.fn(),
}));

import { captureError } from "../sentry.js";
import { isTelegramConfigured, sendTelegramMessage } from "../telegram.js";
import { getLinkedTelegramChatId } from "../telegram-link.js";
import { buildOverrideCallbackData, sendTelegramForPush } from "../telegram-notify.js";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WEB_URL = "https://app.klorn.example";
});

afterEach(() => {
  delete process.env.WEB_URL;
});

describe("buildOverrideCallbackData", () => {
  it("encodes tier + attention item id", () => {
    expect(buildOverrideCallbackData("QUEUE", "item-1")).toBe("ovr:QUEUE:item-1");
    expect(buildOverrideCallbackData("SILENT", "item-1")).toBe("ovr:SILENT:item-1");
  });

  it("stays under Telegram's 64-byte callback_data limit for uuids", () => {
    const data = buildOverrideCallbackData("SILENT", "0b8e7a1c-1111-2222-3333-444455556666");
    expect(data).not.toBeNull();
    expect(Buffer.byteLength(data as string, "utf8")).toBeLessThanOrEqual(64);
  });

  it("returns null when the payload would exceed 64 bytes", () => {
    expect(buildOverrideCallbackData("SILENT", "x".repeat(80))).toBeNull();
  });
});

describe("sendTelegramForPush", () => {
  it("skips when the bot token is not configured", async () => {
    vi.mocked(isTelegramConfigured).mockReturnValueOnce(false);
    const outcome = await sendTelegramForPush("user-1", { title: "T", body: "B" }, "email_urgent");
    expect(outcome).toBe("skipped");
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("skips when the user has no linked chat", async () => {
    vi.mocked(getLinkedTelegramChatId).mockResolvedValueOnce(null);
    const outcome = await sendTelegramForPush("user-1", { title: "T", body: "B" }, "email_urgent");
    expect(outcome).toBe("skipped");
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("sends title + body to the linked chat", async () => {
    const outcome = await sendTelegramForPush(
      "user-1",
      { title: "Urgent mail", body: "Acme contract needs a reply" },
      "email_urgent",
    );
    expect(outcome).toBe("sent");
    const [chatId, text] = vi.mocked(sendTelegramMessage).mock.calls[0];
    expect(chatId).toBe("777");
    expect(text).toContain("Urgent mail");
    expect(text).toContain("Acme contract needs a reply");
  });

  it("adds tier-override buttons when an attention item id is provided", async () => {
    await sendTelegramForPush(
      "user-1",
      { title: "T", body: "B", url: "/briefing", attentionItemId: "item-1" },
      "email_urgent",
    );
    const [, , opts] = vi.mocked(sendTelegramMessage).mock.calls[0];
    const keyboard = opts?.inlineKeyboard ?? [];
    const flat = keyboard.flat();
    expect(flat.some((b) => b.callback_data === "ovr:QUEUE:item-1")).toBe(true);
    expect(flat.some((b) => b.callback_data === "ovr:SILENT:item-1")).toBe(true);
  });

  it("adds an Open Klorn URL button resolved against WEB_URL", async () => {
    await sendTelegramForPush(
      "user-1",
      { title: "T", body: "B", url: "/briefing" },
      "email_urgent",
    );
    const [, , opts] = vi.mocked(sendTelegramMessage).mock.calls[0];
    const flat = (opts?.inlineKeyboard ?? []).flat();
    const open = flat.find((b) => b.url);
    expect(open?.url).toBe("https://app.klorn.example/briefing");
  });

  it("omits the URL button when no absolute URL can be built", async () => {
    delete process.env.WEB_URL;
    await sendTelegramForPush(
      "user-1",
      { title: "T", body: "B", url: "/briefing" },
      "email_urgent",
    );
    const [, , opts] = vi.mocked(sendTelegramMessage).mock.calls[0];
    const flat = (opts?.inlineKeyboard ?? []).flat();
    expect(flat.some((b) => b.url)).toBe(false);
  });

  it("returns failed and captures to Sentry when the Bot API rejects", async () => {
    vi.mocked(sendTelegramMessage).mockResolvedValueOnce({
      ok: false,
      description: "chat not found",
    });
    const outcome = await sendTelegramForPush("user-1", { title: "T", body: "B" }, "email_urgent");
    expect(outcome).toBe("failed");
    expect(captureError).toHaveBeenCalled();
  });

  it("never throws, even when the client itself blows up", async () => {
    vi.mocked(getLinkedTelegramChatId).mockRejectedValueOnce(new Error("db down"));
    const outcome = await sendTelegramForPush("user-1", { title: "T", body: "B" }, "email_urgent");
    expect(outcome).toBe("failed");
    expect(captureError).toHaveBeenCalled();
  });
});
