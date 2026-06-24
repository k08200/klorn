/**
 * BYOK threading contract.
 *
 * The high-traffic classify/judge paths (firewall judge, classify-tool,
 * summarize, naver, github) all resolve a user's own provider key via
 * getUserLlmCredentials() and pass it down to createCompletion(). When a user
 * has set a key (billing.ts), their load must bill *their* key, not the shared
 * env key. When they have not, the resolved credentials carry no keys and
 * getProviderChain() falls through to the shared env provider unchanged.
 *
 * These tests lock the threading at the two library seams every caller relies
 * on — classifyEmailBatch and judgeEmail — by asserting the `credentials`
 * object reaches createCompletion's options argument (and is absent when no
 * credentials are supplied, i.e. the unchanged env-key path).
 */

import { describe, expect, it, vi } from "vitest";

const createCompletionMock = vi.hoisted(() => vi.fn());

vi.mock("../openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../openai.js")>();
  return {
    ...actual,
    createCompletion: createCompletionMock,
  };
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { classifyEmailBatch } from "../email-classifier.js";
import { judgeEmail } from "../poc-judge.js";
import type { ProviderCredentials } from "../providers/index.js";

const USER_KEY: ProviderCredentials = {
  openRouterApiKey: "sk-or-v1-user-owned-key",
  quotaScope: "user-123",
};

// A plain human email — not marketing — so judgeEmail/classifyEmailBatch take
// the LLM path (fast-path/keyword short-circuits never call createCompletion).
const HUMAN_EMAIL = {
  id: "e1",
  from: "Sarah Kim <sarah@acmecorp.com>",
  subject: "Question about the proposal",
  snippet: "Could you take a look at section 3 before our call?",
  labels: [],
};

function mockLlmReturns(content: string) {
  createCompletionMock.mockReset();
  createCompletionMock.mockResolvedValue({
    choices: [{ message: { content } }],
  });
}

describe("BYOK threading — classifyEmailBatch", () => {
  it("forwards the user's credentials to createCompletion", async () => {
    mockLlmReturns(
      JSON.stringify({
        labels: [
          { index: 0, priority: "medium", category: "client", needsReply: true, reason: "q" },
        ],
      }),
    );

    await classifyEmailBatch([HUMAN_EMAIL], "user-123", USER_KEY);

    expect(createCompletionMock).toHaveBeenCalledTimes(1);
    expect(createCompletionMock.mock.calls[0]?.[1]?.credentials).toEqual(USER_KEY);
    // userId still flows for cost accounting.
    expect(createCompletionMock.mock.calls[0]?.[1]?.userId).toBe("user-123");
  });

  it("omits credentials when none are supplied (unchanged shared-env path)", async () => {
    mockLlmReturns(
      JSON.stringify({
        labels: [
          { index: 0, priority: "medium", category: "client", needsReply: true, reason: "q" },
        ],
      }),
    );

    await classifyEmailBatch([HUMAN_EMAIL], "user-123");

    expect(createCompletionMock).toHaveBeenCalledTimes(1);
    expect(createCompletionMock.mock.calls[0]?.[1]?.credentials).toBeUndefined();
  });
});

describe("BYOK threading — judgeEmail", () => {
  it("forwards the user's credentials to createCompletion", async () => {
    // Content shape is irrelevant to this assertion: the call carries the
    // credentials before the response is ever parsed. Return bare JSON so the
    // call resolves without throwing.
    mockLlmReturns("{}");

    await judgeEmail(HUMAN_EMAIL, "user-123", undefined, USER_KEY);

    expect(createCompletionMock).toHaveBeenCalled();
    expect(createCompletionMock.mock.calls[0]?.[1]?.credentials).toEqual(USER_KEY);
  });

  it("omits credentials when none are supplied (unchanged shared-env path)", async () => {
    mockLlmReturns("{}");

    await judgeEmail(HUMAN_EMAIL, "user-123");

    expect(createCompletionMock).toHaveBeenCalled();
    expect(createCompletionMock.mock.calls[0]?.[1]?.credentials).toBeUndefined();
  });
});
