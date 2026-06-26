import { beforeEach, describe, expect, it, vi } from "vitest";

const createCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../openai.js", () => ({
  createCompletion: createCompletionMock,
  JUDGE_MODEL: "test-judge-model",
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { extractTraitsFromEmails } from "../sender-trait-extractor.js";

const emails = [
  { from: "vc@fund.com", subject: "Investment", snippet: "we want to invest", labels: [] },
];

beforeEach(() => createCompletionMock.mockReset());

describe("extractTraitsFromEmails", () => {
  it("returns validated candidates from a well-formed response", async () => {
    createCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              relationship: { value: "investor", confidence: 0.9, evidence: "we want to invest" },
              recurring_intent: { value: "sales_outreach", confidence: 0.7, evidence: "investment pitch" },
            }),
          },
        },
      ],
    });
    const traits = await extractTraitsFromEmails(emails, {});
    expect(traits.map((t) => `${t.factKind}:${t.factValue}`).sort()).toEqual([
      "recurring_intent:sales_outreach",
      "relationship:investor",
    ]);
    expect(traits[0].confidence).toBeGreaterThan(0);
  });

  it("drops a hallucinated value instead of storing it", async () => {
    createCompletionMock.mockResolvedValue({
      choices: [
        { message: { content: JSON.stringify({ relationship: { value: "frenemy", confidence: 0.9, evidence: "x" } }) } },
      ],
    });
    const traits = await extractTraitsFromEmails(emails, {});
    expect(traits).toHaveLength(0);
  });

  it("returns [] and does not throw on an LLM failure", async () => {
    createCompletionMock.mockRejectedValueOnce(new Error("provider down"));
    const result = await extractTraitsFromEmails(emails, {});
    expect(result).toEqual([]);
  });
});
