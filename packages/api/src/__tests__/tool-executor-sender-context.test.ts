/**
 * sender_context chat tool — "what were we discussing with this person".
 * Focus: it is exposed to chat, dispatches to getSenderDossier with a
 * normalized address, and degrades to structured errors (never a throw the
 * chat engine would surface as a bare failure).
 */

import { describe, expect, it, vi } from "vitest";

const getSenderDossier = vi.hoisted(() => vi.fn());
vi.mock("../mail/sender-dossier.js", () => ({ getSenderDossier }));
vi.mock("../mail/gmail.js", () => ({
  classifyEmails: vi.fn(),
  listEmails: vi.fn(),
  readEmail: vi.fn(),
  GMAIL_TOOLS: [],
  createEmailDraft: vi.fn(),
  sendEmail: vi.fn(),
}));
vi.mock("../db.js", () => ({ prisma: {}, db: {} }));

import { CHAT_TOOL_NAMES } from "../agentcore/chat-engine.js";
import { ALL_TOOLS, executeToolCall } from "../agentcore/tool-executor.js";

const call = (args: Record<string, unknown>) => executeToolCall("user-1", "sender_context", args);

describe("sender_context tool", () => {
  it("is registered and reachable from chat", () => {
    expect(ALL_TOOLS.some((t) => t.function.name === "sender_context")).toBe(true);
    expect(CHAT_TOOL_NAMES.has("sender_context")).toBe(true);
  });

  it("returns the dossier for a normalized sender address", async () => {
    getSenderDossier.mockResolvedValueOnce({
      summary: "Paddle support agent on your KYC case.",
      openThreads: ["KYC review"],
      lastPromise: null,
      emailCount: 4,
      lastEmailAt: null,
      fresh: false,
    });
    const out = JSON.parse(await call({ sender_email: "  Sellers@Paddle.com " }));
    expect(out.summary).toContain("KYC");
    expect(getSenderDossier).toHaveBeenCalledWith("user-1", "sellers@paddle.com", "en");
  });

  it("answers structured errors for junk input and empty history", async () => {
    const bad = JSON.parse(await call({ sender_email: "not-an-address" }));
    expect(bad.error).toMatch(/email address/);

    getSenderDossier.mockResolvedValueOnce({
      summary: "",
      openThreads: [],
      lastPromise: null,
      emailCount: 0,
      lastEmailAt: null,
      fresh: false,
    });
    const empty = JSON.parse(await call({ sender_email: "new@nowhere.com" }));
    expect(empty.info).toMatch(/No stored mail/);
  });
});
