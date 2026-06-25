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

vi.mock("../llm-usage.js", () => ({
  recordLlmUsage: vi.fn(async () => {}),
  estimatePrebillCents: vi.fn(() => 0),
  trueUpCostLedgers: vi.fn(async () => {}),
}));

import { createCompletion } from "../openai.js";

describe("createCompletion — per-user model override", () => {
  it("uses options.credentials.userModel for the provider call when set", async () => {
    create.mockClear();
    await createCompletion(
      { model: "google/gemma-4-31b-it:free", messages: [{ role: "user", content: "hi" }] },
      { userId: "u1", credentials: { userModel: "openai/gpt-4o" } },
    );
    expect(create.mock.calls[0]?.[0]?.model).toBe("openai/gpt-4o");
  });

  it("falls back to params.model when no userModel", async () => {
    create.mockClear();
    await createCompletion(
      { model: "google/gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] },
      { userId: "u1", credentials: {} },
    );
    expect(create.mock.calls[0]?.[0]?.model).toBe("google/gemini-2.5-flash");
  });
});
