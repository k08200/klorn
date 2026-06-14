/**
 * backfillEmailAttentionItems — the durable safety net that re-judges emails
 * the fire-and-forget inline path left without an AttentionItem (so they never
 * appear in the firewall). db.js and the judge pipeline are mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const emailFindMany = vi.hoisted(() => vi.fn());
const attentionFindMany = vi.hoisted(() => vi.fn());
const judgeEmail = vi.hoisted(() => vi.fn());
const upsert = vi.hoisted(() => vi.fn(async () => {}));
const buildJudgeContext = vi.hoisted(() =>
  vi.fn(async () => ({ corrections: [], senderPrior: null })),
);
const captureError = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = {
    emailMessage: { findMany: emailFindMany },
    attentionItem: { findMany: attentionFindMany },
  };
  return { prisma, db: prisma };
});
vi.mock("../poc-judge.js", () => ({ judgeEmail }));
vi.mock("../judge-context.js", () => ({ buildJudgeContext }));
vi.mock("../attention-mirror.js", () => ({ upsertAttentionForEmailJudgement: upsert }));
vi.mock("../sentry.js", () => ({ captureError }));

import { backfillEmailAttentionItems } from "../email-sync.js";

function email(id: string, receivedAt: Date) {
  return { id, from: `s-${id}@x.com`, subject: id, snippet: null, labels: [], receivedAt };
}

const T0 = new Date("2026-06-14T00:00:00Z");
const recent = (id: string, minsAgo: number) =>
  email(id, new Date(T0.getTime() - minsAgo * 60_000));

beforeEach(() => {
  emailFindMany.mockReset();
  attentionFindMany.mockReset();
  judgeEmail.mockReset();
  judgeEmail.mockResolvedValue({ tier: "QUEUE", reason: "r", features: {}, source: "llm" });
  upsert.mockClear();
  captureError.mockClear();
});

const judgedSubjects = () => judgeEmail.mock.calls.map((c) => c[0].subject);

describe("backfillEmailAttentionItems", () => {
  it("no-ops when there are no recent emails", async () => {
    emailFindMany.mockResolvedValue([]);
    const n = await backfillEmailAttentionItems("u1");
    expect(n).toBe(0);
    expect(attentionFindMany).not.toHaveBeenCalled();
    expect(judgeEmail).not.toHaveBeenCalled();
  });

  it("only judges emails that have no AttentionItem yet", async () => {
    emailFindMany.mockResolvedValue([recent("a", 1), recent("b", 2), recent("c", 3)]);
    attentionFindMany.mockResolvedValue([{ sourceId: "b" }]); // b already judged
    const n = await backfillEmailAttentionItems("u1");
    expect(n).toBe(2);
    expect(judgedSubjects().sort()).toEqual(["a", "c"]);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it("no-ops (no judging) when every recent email already has an AttentionItem", async () => {
    emailFindMany.mockResolvedValue([recent("a", 1), recent("b", 2)]);
    attentionFindMany.mockResolvedValue([{ sourceId: "a" }, { sourceId: "b" }]);
    const n = await backfillEmailAttentionItems("u1");
    expect(n).toBe(0);
    expect(judgeEmail).not.toHaveBeenCalled();
  });

  it("caps work at the batch limit so a big backlog drains over several ticks", async () => {
    const many = Array.from({ length: 30 }, (_, i) => recent(`e${i}`, i + 1));
    emailFindMany.mockResolvedValue(many);
    attentionFindMany.mockResolvedValue([]);
    const n = await backfillEmailAttentionItems("u1");
    expect(n).toBe(10); // BACKFILL_BATCH
    expect(judgeEmail).toHaveBeenCalledTimes(10);
  });

  it("drains oldest-first (arrival order), not newest-first", async () => {
    // findMany returns newest-first (receivedAt desc); the sweep reverses so
    // the oldest stranded mail is judged first.
    emailFindMany.mockResolvedValue([recent("new", 1), recent("mid", 2), recent("old", 3)]);
    attentionFindMany.mockResolvedValue([]);
    await backfillEmailAttentionItems("u1");
    expect(judgedSubjects()).toEqual(["old", "mid", "new"]);
  });

  it("swallows a per-email failure and keeps going (count excludes the failure)", async () => {
    emailFindMany.mockResolvedValue([recent("a", 1), recent("b", 2), recent("c", 3)]);
    attentionFindMany.mockResolvedValue([]);
    judgeEmail
      .mockResolvedValueOnce({ tier: "QUEUE", reason: "r", features: {}, source: "llm" })
      .mockRejectedValueOnce(new Error("LLM blip"))
      .mockResolvedValueOnce({ tier: "QUEUE", reason: "r", features: {}, source: "llm" });
    const n = await backfillEmailAttentionItems("u1");
    expect(n).toBe(2);
    expect(judgeEmail).toHaveBeenCalledTimes(3);
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});
