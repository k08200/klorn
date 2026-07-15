/**
 * The tier judge extracts 4 numeric feature scores — a classification, not
 * generation — so it must run at temperature 0. At the provider default (~1.0)
 * the same email scored differently run-to-run, swinging the 50-email eval
 * 78%↔88% (pure sampling noise) and flickering production tiers. This locks the
 * deterministic-classifier contract so a future edit can't silently re-introduce
 * sampling noise into the firewall's core decision.
 */

import { describe, expect, it, vi } from "vitest";

const createCompletionMock = vi.hoisted(() => vi.fn());

vi.mock("../llm/openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/openai.js")>();
  return { ...actual, createCompletion: createCompletionMock };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { judgeEmail } from "../poc-judge.js";

describe("judge feature extraction — temperature", () => {
  it("scores features at temperature 0 by default", async () => {
    createCompletionMock.mockReset();
    createCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              confidence: 0.8,
              senderTrust: 0.7,
              reversibility: 0.5,
              urgency: 0.9,
              reason: "test",
            }),
          },
        },
      ],
    });

    // A plain human email — past the marketing fast-path, so the LLM scorer runs.
    await judgeEmail({
      from: "Sarah Kim <sarah@acmecorp.com>",
      subject: "Question about the proposal",
      snippet: "Could you take a look at section 3?",
      labels: [],
    });

    expect(createCompletionMock).toHaveBeenCalled();
    expect(createCompletionMock.mock.calls[0]?.[0]?.temperature).toBe(0);
  });
});
