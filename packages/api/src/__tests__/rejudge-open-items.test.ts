/**
 * The operator re-judge of a user's OPEN email items (scripts/rejudge-open-email-items.ts
 * is a thin CLI over this). Human always wins: an item carrying a human override or
 * an MCP agent's lane is never judged-for-overwrite and never counted as a tier
 * change. It is counted as KEPT, in dry-run and in apply mode alike, so the summary
 * an operator reads before `CONFIRM=1` matches what `CONFIRM=1` will do.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const judgeEmail = vi.hoisted(() => vi.fn());

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../judge/poc-judge.js", () => ({ judgeEmail }));
vi.mock("../judge/judge-context.js", () => ({
  buildJudgeContext: vi.fn(async () => ({ corrections: [], senderPrior: null, senderFacts: null })),
}));
vi.mock("../llm/llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn(async () => ({})) }));

import { rejudgeOpenEmailItems } from "../judge/rejudge-open-items.js";

const USER = "user-1";
const NOW = new Date("2026-09-30T10:00:00.000Z");
const STAMP = new Date("2026-09-30T09:00:00.000Z");
const FEATURES = { confidence: 0.9, senderTrust: 0.8, reversibility: 0.5, urgency: 0.9 };
const PUSH = { tier: "PUSH", reason: "Urgent and confident", features: FEATURES, source: "llm" };

const email = (id: string): Row => ({
  id,
  userId: USER,
  gmailId: `g-${id}`,
  from: "Alice <alice@corp.example>",
  subject: `Subject ${id}`,
  snippet: "snippet",
  body: null,
  labels: ["INBOX"],
  receivedAt: new Date(NOW.getTime() - 3_600_000),
});

const item = (sourceId: string, over: Row = {}): Row => ({
  id: `item-${sourceId}`,
  userId: USER,
  source: "EMAIL",
  sourceId,
  type: "REPLY_NEEDED",
  title: `Subject ${sourceId}`,
  status: "OPEN",
  tier: "QUEUE",
  tierReason: "judge",
  isManualOverride: false,
  agentTierSetAt: null,
  agentTierKeyId: null,
  surfacedAt: new Date(NOW.getTime() - 3_600_000),
  ...over,
});

let db: FakeDb;
const rowOf = (sourceId: string) =>
  db.tables.attentionItem.find((r) => r.sourceId === sourceId) as Row;

function seed(hooks = {}) {
  db = createFakeDb(
    {
      // "gone" has an open item but no EmailMessage.
      emailMessage: ["plain", "same", "human", "agent"].map(email),
      attentionItem: [
        item("plain"),
        item("same", { tier: "PUSH" }),
        item("human", { tier: "SILENT", isManualOverride: true }),
        item("agent", { tier: "INFO", agentTierSetAt: STAMP, agentTierKeyId: "key-1" }),
        item("gone"),
      ],
      decisionLabel: [],
    },
    hooks,
  );
  dbHolder.current = db;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  judgeEmail.mockReset();
  judgeEmail.mockResolvedValue(PUSH);
  seed();
});

describe("rejudgeOpenEmailItems", () => {
  it("dry run: counts a human override and an agent lane as KEPT (not changed), judges only the rest, writes nothing", async () => {
    const summary = await rejudgeOpenEmailItems(USER, { confirm: false, log: () => {} });

    expect(summary).toMatchObject({ changed: 1, kept: 2, missing: 1 });
    expect([...summary.transitions]).toEqual([["QUEUE→PUSH", 1]]);
    // plain and same are judged; the two protected items are not (no wasted model call).
    expect(judgeEmail).toHaveBeenCalledTimes(2);
    expect(db.writes.attentionItem).toBeUndefined();
    expect(rowOf("plain").tier).toBe("QUEUE");
  });

  it("apply: the same counters, the plain item rewritten, the protected items untouched", async () => {
    const summary = await rejudgeOpenEmailItems(USER, { confirm: true, log: () => {} });

    expect(summary).toMatchObject({ changed: 1, kept: 2, missing: 1 });
    expect(rowOf("plain")).toMatchObject({ tier: "PUSH", tierReason: "Urgent and confident" });
    expect(rowOf("human")).toMatchObject({ tier: "SILENT", isManualOverride: true });
    expect(rowOf("agent")).toMatchObject({ tier: "INFO", agentTierSetAt: STAMP });
    expect(judgeEmail).toHaveBeenCalledTimes(2);
  });

  it("dry-run and apply report identical counters", async () => {
    const dry = await rejudgeOpenEmailItems(USER, { confirm: false, log: () => {} });
    seed();
    const applied = await rejudgeOpenEmailItems(USER, { confirm: true, log: () => {} });
    expect({ ...applied, transitions: [...applied.transitions] }).toEqual({
      ...dry,
      transitions: [...dry.transitions],
    });
  });

  it("an item whose override lands DURING the judge call is counted as kept, not changed", async () => {
    judgeEmail.mockImplementation(async () => {
      Object.assign(rowOf("plain"), { tier: "SILENT", isManualOverride: true });
      return PUSH;
    });
    const summary = await rejudgeOpenEmailItems(USER, { confirm: true, log: () => {} });
    expect(summary).toMatchObject({ changed: 0, kept: 3, missing: 1 });
    expect(rowOf("plain")).toMatchObject({ tier: "SILENT", isManualOverride: true });
    expect(summary.transitions.size).toBe(0);
  });

  it("says nothing to do when there are no open items", async () => {
    db = createFakeDb({ emailMessage: [], attentionItem: [], decisionLabel: [] });
    dbHolder.current = db;
    const lines: string[] = [];
    const summary = await rejudgeOpenEmailItems(USER, { confirm: true, log: (l) => lines.push(l) });
    expect(summary).toMatchObject({ changed: 0, kept: 0, missing: 0 });
    expect(lines.join("\n")).toMatch(/no OPEN email items/);
    expect(judgeEmail).not.toHaveBeenCalled();
  });
});
