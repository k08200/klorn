/**
 * What the code that REWRITES an email item's tier does with an MCP agent's lane
 * (step A2b), proved on seeded rows rather than by asserting the shape of a
 * query: fallback-rejudge must skip an agent-set item, and the plain upsert (the
 * path for new items) replaces the tier and must therefore clear the stamp.
 * The heal and the guarded re-judge write are in firewall-hash-verify and
 * email-rejudge-human-wins.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const judgeEmailMock = vi.hoisted(() => vi.fn());

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../judge/poc-judge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../judge/poc-judge.js")>()),
  judgeEmail: judgeEmailMock,
}));
vi.mock("../judge/judge-context.js", () => ({
  buildJudgeContext: vi.fn(async () => ({ senderFacts: null })),
}));

import { sweepAttentionAging } from "../judge/attention-aging.js";
import { upsertAttentionForEmailJudgement } from "../judge/attention-mirror.js";
import { rejudgeFallbackItems } from "../judge/fallback-rejudge.js";

const USER = "user-1";
const NOW = new Date("2026-09-30T10:00:00.000Z");
const STAMP = new Date("2026-09-30T09:00:00.000Z");
const FEATURES = { confidence: 0.9, senderTrust: 0.8, reversibility: 0.5, urgency: 0.9 };
const LLM_PUSH = {
  tier: "PUSH",
  reason: "Urgent and confident",
  features: FEATURES,
  source: "llm",
};

let db: FakeDb;

function emailRow(id: string): Row {
  return {
    id,
    userId: USER,
    gmailId: `g-${id}`,
    from: "Alice <alice@corp.example>",
    subject: `Subject ${id}`,
    snippet: "snippet",
    body: null,
    labels: ["INBOX"],
    receivedAt: new Date(NOW.getTime() - 3_600_000),
  };
}

function itemRow(sourceId: string, over: Row = {}): Row {
  return {
    id: `item-${sourceId}`,
    userId: USER,
    source: "EMAIL",
    sourceId,
    type: "REPLY_NEEDED",
    title: `Subject ${sourceId}`,
    status: "OPEN",
    tier: "QUEUE",
    tierReason: "keyword fallback",
    isManualOverride: false,
    agentTierSetAt: null,
    agentTierKeyId: null,
    ...over,
  };
}

const fallbackLedger = (sourceId: string): Row => ({
  userId: USER,
  source: "EMAIL",
  sourceId,
  shownTier: "QUEUE",
  features: FEATURES,
  decidedBy: "keyword-fallback",
  outcome: null,
  judgedAt: new Date(NOW.getTime() - 3_600_000),
});

const itemOf = (sourceId: string) =>
  db.tables.attentionItem.find((r) => r.sourceId === sourceId) as Row;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  judgeEmailMock.mockReset();
  judgeEmailMock.mockResolvedValue(LLM_PUSH);
});

describe("fallback-rejudge", () => {
  const seed = (hooks = {}) => {
    db = createFakeDb(
      {
        emailMessage: [emailRow("m-agent"), emailRow("m-plain")],
        attentionItem: [
          itemRow("m-agent", { agentTierSetAt: STAMP, agentTierKeyId: "key-1", tier: "INFO" }),
          itemRow("m-plain"),
        ],
        decisionLabel: [fallbackLedger("m-agent"), fallbackLedger("m-plain")],
      },
      hooks,
    );
    dbHolder.current = db;
  };

  it("skips an item an agent moved (it is not even judged) and still repairs the plain one", async () => {
    seed();
    const summary = await rejudgeFallbackItems(USER, { apply: true, delayMs: 0 });

    expect(judgeEmailMock).toHaveBeenCalledTimes(1);
    expect(summary.changed).toBe(1);
    expect(itemOf("m-plain")).toMatchObject({ tier: "PUSH", tierReason: "Urgent and confident" });
    expect(itemOf("m-agent")).toMatchObject({
      tier: "INFO",
      agentTierSetAt: STAMP,
      agentTierKeyId: "key-1",
    });
    // The ledger row of the skipped item is untouched.
    expect(db.tables.decisionLabel.find((r) => r.sourceId === "m-agent")).toMatchObject({
      shownTier: "QUEUE",
      decidedBy: "keyword-fallback",
    });
  });

  it("an agent lane that lands between the read and the guarded write is not overwritten", async () => {
    seed({
      beforeUpdateMany: (model: string) => {
        if (model === "attentionItem") {
          Object.assign(itemOf("m-plain"), { tier: "SILENT", agentTierSetAt: STAMP });
        }
      },
    });
    await rejudgeFallbackItems(USER, { apply: true, delayMs: 0 });
    expect(itemOf("m-plain")).toMatchObject({ tier: "SILENT", agentTierSetAt: STAMP });
  });
});

describe("the plain upsert (a new item's path) on an existing agent-set row", () => {
  const email = {
    id: "e1",
    userId: USER,
    from: "Alice <alice@corp.example>",
    subject: "Term sheet",
    snippet: "Please review",
    labels: ["INBOX"],
    receivedAt: new Date(NOW.getTime() - 60_000),
  };

  it("replaces the tier with the judge's and clears the agent stamp, without duplicating the row", async () => {
    db = createFakeDb({
      attentionItem: [
        itemRow("e1", { agentTierSetAt: STAMP, agentTierKeyId: "key-1", tier: "INFO" }),
      ],
      decisionLabel: [],
    });
    dbHolder.current = db;

    const outcome = await upsertAttentionForEmailJudgement(email, LLM_PUSH);

    expect(outcome).toBe("written");
    expect(db.tables.attentionItem).toHaveLength(1);
    expect(itemOf("e1")).toMatchObject({
      tier: "PUSH",
      tierReason: "Urgent and confident",
      isManualOverride: false,
      agentTierSetAt: null,
      agentTierKeyId: null,
    });
  });

  it("creates a new item with no agent stamp", async () => {
    db = createFakeDb({ attentionItem: [], decisionLabel: [] });
    dbHolder.current = db;
    await upsertAttentionForEmailJudgement(email, LLM_PUSH);
    expect(itemOf("e1")).toMatchObject({ tier: "PUSH", agentTierSetAt: null, status: "OPEN" });
  });
});

describe("attention aging", () => {
  const OLD = new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000);

  function seedAging() {
    const ids = ["s-judge", "s-agent", "q-judge", "q-agent", "gone-agent"];
    db = createFakeDb({
      emailMessage: ids.map((id) => ({
        ...emailRow(id),
        // The last one left the INBOX (archived elsewhere); the rest are live.
        labels: id === "gone-agent" ? ["ARCHIVE"] : ["INBOX"],
      })),
      attentionItem: [
        itemRow("s-judge", { tier: "SILENT", surfacedAt: OLD }),
        itemRow("s-agent", { tier: "SILENT", surfacedAt: OLD, agentTierSetAt: STAMP }),
        itemRow("q-judge", { tier: "QUEUE", surfacedAt: OLD }),
        itemRow("q-agent", { tier: "QUEUE", surfacedAt: OLD, agentTierSetAt: STAMP }),
        itemRow("gone-agent", { tier: "QUEUE", surfacedAt: NOW, agentTierSetAt: STAMP }),
      ],
    });
    dbHolder.current = db;
  }

  it("ages out an old judge-tiered SILENT or QUEUE item but never an agent-set one", async () => {
    // An injected agent must not be able to demote an important old mail to SILENT
    // and have the aging sweep resolve it within the hour.
    seedAging();
    await sweepAttentionAging(NOW);
    expect(itemOf("s-judge").status).toBe("RESOLVED");
    expect(itemOf("q-judge").status).toBe("RESOLVED");
    expect(itemOf("s-agent").status).toBe("OPEN");
    expect(itemOf("q-agent").status).toBe("OPEN");
  });

  it("still resolves an agent-set item whose email was archived elsewhere (acted-elsewhere is not aging)", async () => {
    seedAging();
    await sweepAttentionAging(NOW);
    expect(itemOf("gone-agent").status).toBe("RESOLVED");
  });
});
