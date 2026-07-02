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
    findMany: vi.fn(async () => [] as { sourceSig: string }[]),
    create: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
  },
}));
vi.mock("../db.js", () => ({ prisma: prismaMock }));
vi.mock("../llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn(async () => undefined) }));

import { extractSenderTraitsForUser, extractTraitsFromEmails } from "../sender-trait-extractor.js";
import { computeTraitSourceSig } from "../sender-trait-signature.js";

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
              recurring_intent: {
                value: "sales_outreach",
                confidence: 0.7,
                evidence: "investment pitch",
              },
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
        {
          message: {
            content: JSON.stringify({
              relationship: { value: "frenemy", confidence: 0.9, evidence: "x" },
            }),
          },
        },
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
    prismaMock.senderTrait.findMany.mockReset().mockResolvedValue([]);
    prismaMock.senderTrait.create.mockReset().mockResolvedValue({});
    prismaMock.senderTrait.update.mockReset().mockResolvedValue({});
  });

  it("skips the paid LLM call and writes when EVERY stored row matches the sample sig", async () => {
    const sample = [{ from: "a@x.com", subject: "s", snippet: "b", labels: [] }];
    prismaMock.emailMessage.findMany.mockResolvedValue(sample);
    // Both of the sender's trait rows already carry the signature of this exact
    // sample, so re-extraction is a no-op: no LLM, no write, no re-increment.
    const unchangedSig = computeTraitSourceSig([
      { from: "a@x.com", subject: "s", snippet: "b", labels: [] },
    ]);
    prismaMock.senderTrait.findMany.mockResolvedValue([
      { sourceSig: unchangedSig },
      { sourceSig: unchangedSig },
    ]);

    const summary = await extractSenderTraitsForUser("user-1");

    expect(createCompletionMock).not.toHaveBeenCalled();
    expect(prismaMock.senderTrait.create).not.toHaveBeenCalled();
    expect(prismaMock.senderTrait.update).not.toHaveBeenCalled();
    expect(summary.sendersSkipped).toBe(1);
    expect(summary.sendersProcessed).toBe(1);
  });

  it("does NOT skip when one factKind row's sig has diverged (stale/omitted/conflict)", async () => {
    const sample = [{ from: "a@x.com", subject: "s", snippet: "b", labels: [] }];
    prismaMock.emailMessage.findMany.mockResolvedValue(sample);
    const currentSig = computeTraitSourceSig([
      { from: "a@x.com", subject: "s", snippet: "b", labels: [] },
    ]);
    // relationship advanced to the current sample; recurring_intent is frozen at
    // an older sig (omitted candidate or a conflict row that never advanced).
    // A single arbitrary row must NOT gate the whole sender — we must re-run.
    prismaMock.senderTrait.findMany.mockResolvedValue([
      { sourceSig: currentSig },
      { sourceSig: "stale-old-sig" },
    ]);
    createCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              relationship: { value: "investor", confidence: 0.9, evidence: "b" },
            }),
          },
        },
      ],
    });

    const summary = await extractSenderTraitsForUser("user-1");

    expect(createCompletionMock).toHaveBeenCalledTimes(1);
    expect(summary.sendersSkipped).toBe(0);
  });

  it("isolates a failing sender — the other still persists", async () => {
    prismaMock.emailMessage.findMany.mockResolvedValue([
      { from: "a@x.com", subject: "s", snippet: "b", labels: [] },
      { from: "b@x.com", subject: "s", snippet: "b", labels: [] },
    ]);
    // Both senders extract a valid trait...
    createCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              relationship: { value: "vendor", confidence: 0.8, evidence: "b" },
            }),
          },
        },
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
