import { describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() =>
  vi.fn(async () => ({ choices: [{ message: { content: "{}" } }], usage: null })),
);

vi.mock("../providers/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/index.js")>();
  return {
    ...actual,
    getProviderChain: () => [
      {
        name: "openrouter",
        quotaKey: "openrouter:env",
        defaultModel: "google/gemma-4-31b-it:free",
        supportsTools: true,
        client: null,
        resolveModel: (m: string) => m,
        ownedByUser: false,
        call: async (params: { model: string }, model: string) => create({ ...params, model }),
      },
    ],
  };
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

vi.mock("../db.js", () => ({
  prisma: {
    llmCostLedger: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
    },
  },
  db: {},
}));

vi.mock("../billing/llm-usage.js", () => ({
  recordLlmUsage: vi.fn(async () => {}),
  estimatePrebillCents: vi.fn(() => 0),
  trueUpCostLedgers: vi.fn(async () => {}),
}));

import { createCompletion, createVisionCompletion, VISION_MODEL } from "../openai.js";

describe("createCompletion — chat-surface model override (useUserModel)", () => {
  it("applies credentials.userModel ONLY when the call opts in via useUserModel", async () => {
    create.mockClear();
    await createCompletion(
      { model: "google/gemma-4-31b-it:free", messages: [{ role: "user", content: "hi" }] },
      { userId: "u1", credentials: { userModel: "anthropic/claude-sonnet-5" }, useUserModel: true },
    );
    expect(create.mock.calls[0]?.[0]?.model).toBe("anthropic/claude-sonnet-5");
  });

  it("PINNED surfaces ignore userModel when useUserModel is absent (judge/summarize/draft)", async () => {
    create.mockClear();
    await createCompletion(
      { model: "google/gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] },
      { userId: "u1", credentials: { userModel: "anthropic/claude-sonnet-5" } },
    );
    expect(create.mock.calls[0]?.[0]?.model).toBe("google/gemini-2.5-flash");
  });

  it("falls back to params.model when no userModel", async () => {
    create.mockClear();
    await createCompletion(
      { model: "google/gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] },
      { userId: "u1", credentials: {}, useUserModel: true },
    );
    expect(create.mock.calls[0]?.[0]?.model).toBe("google/gemini-2.5-flash");
  });
});

describe("createVisionCompletion — pinned, never steered by chat choice", () => {
  it("ignores credentials.userModel entirely (a text pick may not be multimodal)", async () => {
    create.mockClear();
    await createVisionCompletion(
      { model: VISION_MODEL, messages: [{ role: "user", content: "describe this" }] },
      { userId: "u1", credentials: { userModel: "anthropic/claude-sonnet-5" } },
    );
    expect(create.mock.calls[0]?.[0]?.model).toBe(VISION_MODEL);
  });

  it("uses VISION_MODEL when no userModel is set", async () => {
    create.mockClear();
    await createVisionCompletion(
      { model: VISION_MODEL, messages: [{ role: "user", content: "describe this" }] },
      { userId: "u1", credentials: {} },
    );
    expect(create.mock.calls[0]?.[0]?.model).toBe(VISION_MODEL);
  });
});
