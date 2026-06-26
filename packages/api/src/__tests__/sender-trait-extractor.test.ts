import { beforeEach, describe, expect, it, vi } from "vitest";

const createCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../openai.js", () => ({
  createCompletion: createCompletionMock,
  JUDGE_MODEL: "test-judge-model",
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const prismaMock = vi.hoisted(() => ({
  emailMessage: { findMany: vi.fn() },
  user: { findMany: vi.fn(async () => []) },
  senderTrait: {
    findUnique: vi.fn(async () => null),
    create: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
  },
}));
vi.mock("../db.js", () => ({ prisma: prismaMock }));
vi.mock("../llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn(async () => undefined) }));

import { extractSenderTraitsForUser, extractTraitsFromEmails } from "../sender-trait-extractor.js";

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

describe("extractSenderTraitsForUser — per-sender isolation", () => {
  beforeEach(() => {
    prismaMock.emailMessage.findMany.mockReset();
    prismaMock.senderTrait.findUnique.mockReset().mockResolvedValue(null);
    prismaMock.senderTrait.create.mockReset().mockResolvedValue({});
    prismaMock.senderTrait.update.mockReset().mockResolvedValue({});
  });

  it("isolates a failing sender — the other still persists", async () => {
    prismaMock.emailMessage.findMany.mockResolvedValue([
      { from: "a@x.com", subject: "s", snippet: "b", labels: [] },
      { from: "b@x.com", subject: "s", snippet: "b", labels: [] },
    ]);
    // Both senders extract a valid trait...
    createCompletionMock.mockResolvedValue({
      choices: [
        { message: { content: JSON.stringify({ relationship: { value: "vendor", confidence: 0.8, evidence: "b" } }) } },
      ],
    });
    // ...but ONE sender's DB write throws (extractTraitsFromEmails never throws,
    // so isolation must be exercised on the write path). Promise.allSettled keeps
    // the other sender alive.
    prismaMock.senderTrait.create
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValue({});

    const summary = await extractSenderTraitsForUser("user-1");
    expect(summary.sendersProcessed).toBe(2);
    expect(summary.sendersFailed).toBe(1);
    expect(prismaMock.senderTrait.create).toHaveBeenCalledTimes(2); // both attempted
  });
});
