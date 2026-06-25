import { afterEach, describe, expect, it, vi } from "vitest";

describe("shared default model", () => {
  const orig = process.env.NODE_ENV;
  const origChat = process.env.CHAT_MODEL;
  afterEach(() => {
    process.env.NODE_ENV = orig;
    if (origChat === undefined) delete process.env.CHAT_MODEL;
    else process.env.CHAT_MODEL = origChat;
    vi.resetModules();
  });

  it("defaults MODEL to paid flash on a funded deploy (NODE_ENV=production)", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.CHAT_MODEL;
    vi.resetModules();
    const { MODEL } = await import("../openai.js");
    expect(MODEL).toBe("google/gemini-2.5-flash");
  });

  it("keeps the :free default off prod (self-host)", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.CHAT_MODEL;
    vi.resetModules();
    const { MODEL } = await import("../openai.js");
    expect(MODEL).toBe("google/gemma-4-31b-it:free");
  });

  it("still honors an explicit CHAT_MODEL override", async () => {
    process.env.NODE_ENV = "production";
    process.env.CHAT_MODEL = "openai/gpt-4o";
    vi.resetModules();
    const { MODEL } = await import("../openai.js");
    expect(MODEL).toBe("openai/gpt-4o");
  });
});
