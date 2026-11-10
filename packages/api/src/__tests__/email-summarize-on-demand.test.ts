/**
 * summarizeEmailOnDemand — deep single-email re-summary behind the reading
 * pane's AI-정리 button. Focus: no-provider null degradation, the requested
 * output language reaching the prompt, foreground billing priority, and the
 * shared persist path (LOW clamp + reply signal) writing the columns.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const createCompletion = vi.hoisted(() => vi.fn());
const getProviderChain = vi.hoisted(() => vi.fn());
const emailUpdate = vi.hoisted(() => vi.fn());

vi.mock("../llm/openai.js", () => ({ createCompletion, MODEL: "test-model" }));
vi.mock("../llm/llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn(async () => ({})) }));
vi.mock("../providers/index.js", () => ({ getProviderChain }));
vi.mock("../resolve-user-email.js", () => ({ resolveUserEmail: vi.fn(async () => "me@k.co") }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../db.js", () => {
  const prisma = {
    // Inbox-purpose lookups (resolveInboxPurpose) — null = unset, keeps
    // the legacy preamble.
    user: { findUnique: vi.fn(async () => null) },
    linkedInboxAccount: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    // Sender-label lookup (2026-09-11): the prompt line for a corrected sender.
    senderLabel: { findMany: vi.fn(async () => []) },
    emailMessage: { update: emailUpdate, findMany: vi.fn(async () => []) },
  };
  return { prisma, db: prisma };
});

import { summarizeEmailOnDemand } from "../mail/email-summarize.js";

const EMAIL = {
  id: "e1",
  from: "Paddle <sellers@paddle.com>",
  subject: "Re: KYC blocked",
  body: "Manual review in progress.",
  htmlBody: null,
  snippet: null,
  labels: [] as string[],
  priority: "NORMAL",
};

const LLM_JSON = JSON.stringify({
  summary: "Paddle: KYC manual review in progress",
  category: "business",
  keyPoints: ["Review started 2026-08-19"],
  actionItems: [],
  sentiment: "neutral",
  priority: "URGENT",
});

beforeEach(() => {
  createCompletion.mockReset();
  getProviderChain.mockReset();
  emailUpdate.mockReset();
  getProviderChain.mockReturnValue(["prov"]);
  createCompletion.mockResolvedValue({ choices: [{ message: { content: LLM_JSON } }] });
  emailUpdate.mockResolvedValue({});
});

describe("summarizeEmailOnDemand", () => {
  it("returns null (no throw) when no provider chain is configured", async () => {
    getProviderChain.mockReturnValue([]);
    expect(await summarizeEmailOnDemand("user-1", EMAIL, "en")).toBeNull();
    expect(createCompletion).not.toHaveBeenCalled();
  });

  it("asks for Korean output when lang=ko and bills foreground", async () => {
    await summarizeEmailOnDemand("user-1", EMAIL, "ko");
    const [req, opts] = createCompletion.mock.calls[0];
    expect(req.messages[0].content).toContain("Korean");
    expect(opts).toMatchObject({ userId: "user-1", priority: "foreground" });
  });

  it("persists the result columns and returns the reply signal", async () => {
    const result = await summarizeEmailOnDemand("user-1", EMAIL, "en");
    expect(emailUpdate).toHaveBeenCalledTimes(1);
    const { where, data } = emailUpdate.mock.calls[0][0];
    expect(where).toEqual({ id: "e1" });
    expect(data.summary).toBe("Paddle: KYC manual review in progress");
    expect(data.keyPoints).toEqual(["Review started 2026-08-19"]);
    expect(result).toMatchObject({ summary: data.summary, needsReply: expect.any(Boolean) });
  });

  it("keeps the LOW floor: a LOW email cannot be upgraded by the model", async () => {
    const result = await summarizeEmailOnDemand("user-1", { ...EMAIL, priority: "LOW" }, "en");
    expect(emailUpdate.mock.calls[0][0].data.priority).toBe("LOW");
    expect(result?.priority).toBe("LOW");
  });
});
