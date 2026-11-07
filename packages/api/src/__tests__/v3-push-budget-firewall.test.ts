/**
 * The v3 live decision and PUSH interrupt budget on the firewall judge
 * (docs/design/attention-engine-v3.md §3(5) "Live decision", JUDGE_V3_POLICY).
 *
 * The real judgeAndMirrorEmail runs over the in-memory database; only the v2
 * judge, the live facts call, the relationship loader and the outward-facing
 * notifiers are mocked. Covers: the policy applies only to users the shadow
 * flag covers; the budget is never exceeded; a held PUSH is written as QUEUE
 * with heldAt before anyone can see it, and stays held on a re-judge; MEETING
 * is not budgeted; the existing 6h and dedupe gates run first and spend no
 * budget; strangers stop at their share; live and stored facts decide the
 * lane; missing facts keep the v2 lane; and the flag-off path is unchanged.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const judgeEmail = vi.hoisted(() => vi.fn());
const sendPushNotification = vi.hoisted(() => vi.fn(async () => ({})));
const extractFactsForDecision = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ status: "error" })),
);
const loadRelationshipSnapshot = vi.hoisted(() => vi.fn());

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../judge/poc-judge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../judge/poc-judge.js")>()),
  judgeEmail,
}));
vi.mock("../judge/judge-context.js", () => ({
  buildJudgeContext: vi.fn(async () => ({ corrections: [], senderPrior: null, senderFacts: null })),
}));
vi.mock("../llm/llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn(async () => ({})) }));
vi.mock("../notify/notification-strings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../notify/notification-strings.js")>()),
  getUserNotificationLanguage: vi.fn(async () => "en"),
}));
vi.mock("../notify/push.js", () => ({ sendPushNotification }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../notify/conversations-updated.js", () => ({ notifyConversationsUpdated: vi.fn() }));
vi.mock("../judge/v3/live-facts.js", () => ({ extractFactsForDecision }));
vi.mock("../judge/v3/relationship-loader.js", () => ({
  loadRelationshipSnapshot,
  SENT_EVIDENCE_WHERE: {},
}));
vi.mock("../mail/gmail-labels.js", () => ({
  applyLaneLabel: vi.fn(async () => "applied"),
  isLabelModeEnabled: () => false,
  laneForLabelIds: vi.fn(async () => null),
}));

import { backfillEmailAttentionItems, judgeAndMirrorEmail } from "../judge/email-firewall.js";
import { FACTS_VERSION } from "../judge/v3/facts-schema.js";
import { V3_LANE_REASON_KEY } from "../judge/v3/live-judge.js";
import { POLICY_VERSION } from "../judge/v3/policy.js";
import type { FactsV1 } from "../judge/v3/policy-types.js";
import { HELD_REASON_KEY } from "../judge/v3/push-budget-gate.js";
import { UNKNOWN_RELATIONSHIP } from "../judge/v3/relationship.js";
import type { GmailRawEmail } from "../mail/gmail-fetch.js";
import { applyLaneLabel } from "../mail/gmail-labels.js";

const USER = "user-1";
// 00:30 in Seoul: the budget day is 2026-11-01 there, still 2026-10-31 in UTC.
const NOW = new Date("2026-10-31T15:30:00.000Z");
const HOUR = 60 * 60_000;
const IDS = ["e1", "e2", "e3", "e4", "e5", "e6"];

let db: FakeDb;

function seed(
  extra: {
    notification?: Row[];
    timezone?: string;
    config?: Row;
    attentionItem?: Row[];
    attentionFacts?: Row[];
  } = {},
  hooks: Parameters<typeof createFakeDb>[1] = {},
) {
  const config =
    extra.timezone || extra.config
      ? [{ id: "cfg", userId: USER, timezone: extra.timezone ?? "Asia/Seoul", ...extra.config }]
      : [];
  db = createFakeDb(
    {
      emailMessage: IDS.map((id) => ({
        id,
        userId: USER,
        gmailId: `g-${id}`,
        from: "Alice <alice@example.com>",
        to: "me@example.com",
        subject: `Subject ${id}`,
        createdAt: NOW,
      })),
      attentionItem: extra.attentionItem ?? [],
      attentionFacts: extra.attentionFacts ?? [],
      decisionLabel: [],
      notification: extra.notification ?? [],
      automationConfig: config,
      user: [],
      linkedInboxAccount: [],
    },
    hooks,
  );
  dbHolder.current = db;
}

function judgedAs(tier: "PUSH" | "MEETING" | "QUEUE", source = "llm") {
  judgeEmail.mockResolvedValueOnce({
    tier,
    reason: "Urgent",
    features: { confidence: 0.9, senderTrust: 0.8, reversibility: 0.5, urgency: 0.9 },
    source,
    autoEligible: false,
  });
}

const judge = (
  id: string,
  over: { receivedAt?: Date; from?: string } = {},
  options: { rejudge?: boolean; liveRaw?: GmailRawEmail } = {},
) =>
  judgeAndMirrorEmail(
    USER,
    {
      id,
      gmailId: `g-${id}`,
      from: "Alice <alice@example.com>",
      subject: `Subject ${id}`,
      snippet: "Please sign today",
      labels: ["INBOX"],
      receivedAt: new Date(NOW.getTime() - 60_000),
      linkedInboxAccountId: null,
      ...over,
    },
    undefined,
    undefined,
    options,
  );

const TRUSTED = { ...UNKNOWN_RELATIONSHIP, sentCount: 2 };

const facts = (over: Partial<FactsV1> = {}): FactsV1 => ({
  asks: [],
  addressedTo: "me_direct",
  threadTurn: "none",
  event: null,
  transaction: null,
  risk: [],
  kind: "personal",
  ambiguous: false,
  ...over,
});

const dueSoon = (): FactsV1 =>
  facts({
    asks: [
      {
        kind: "reply",
        object: "the contract",
        due: new Date(NOW.getTime() + 2 * HOUR).toISOString(),
        evidence: "by noon today",
      },
    ],
  });

/** What the live facts call returns for LLM facts (an extraction, trimmed). */
const liveFacts = (f: FactsV1) => ({
  status: "ok",
  extraction: {
    facts: f,
    source: "llm",
    preFacts: {},
    certain: [],
    signals: { automatedSender: false, spam: false },
  },
  relationship: TRUSTED,
});

const raw = (id: string) =>
  ({
    gmailId: `g-${id}`,
    threadId: null,
    from: "Alice <alice@example.com>",
    to: "me@example.com",
    cc: "",
    subject: `Subject ${id}`,
    snippet: "Please sign today",
    body: "Please sign today",
    htmlBody: "",
    labels: ["INBOX"],
    isRead: false,
    isStarred: false,
    receivedAt: new Date(NOW.getTime() - 60_000),
    attachments: [],
  }) as unknown as GmailRawEmail;

const item = (id: string): Row | undefined =>
  (db.tables.attentionItem ?? []).find((r) => r.sourceId === id);
const label = (id: string): Row | undefined =>
  (db.tables.decisionLabel ?? []).find((r) => r.sourceId === id);
const slotKeys = () =>
  (db.tables.notification ?? [])
    .map((r) => r.dedupeKey)
    .filter((k): k is string => typeof k === "string" && k.startsWith("interrupt:"))
    .sort();

// The push path lazy-imports these. Load them once up front so concurrent
// judgements all resolve the mocked modules.
beforeAll(async () => {
  await Promise.all([
    import("../notify/push.js"),
    import("../websocket.js"),
    import("../judge/attention-override.js"),
    import("../notify/desktop-alert.js"),
  ]);
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  judgeEmail.mockReset();
  sendPushNotification.mockClear();
  vi.mocked(applyLaneLabel).mockClear();
  extractFactsForDecision.mockReset();
  extractFactsForDecision.mockResolvedValue({ status: "error" });
  // Known senders by default, so the trusted reserve does not cut the cases
  // that are about the budget itself; the reserve has its own case.
  loadRelationshipSnapshot.mockReset();
  loadRelationshipSnapshot.mockResolvedValue(TRUSTED);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.JUDGE_V3_POLICY;
  delete process.env.JUDGE_V3_SHADOW;
  delete process.env.JUDGE_V3_PUSH_BUDGET;
});

describe("flag off (default): the push path is unchanged", () => {
  it("notifies every fresh PUSH and writes no budget slot", async () => {
    seed();
    for (const id of IDS) {
      judgedAs("PUSH");
      expect(await judge(id)).toBe("PUSH");
    }
    expect(sendPushNotification).toHaveBeenCalledTimes(IDS.length);
    expect(slotKeys()).toEqual([]);
    expect(IDS.every((id) => item(id)?.tier === "PUSH")).toBe(true);
  });
});

describe("JUDGE_V3_POLICY on, for a user the shadow flag does not cover", () => {
  it("keeps v2 exactly: every fresh PUSH rings and no slot or v3 column is written", async () => {
    process.env.JUDGE_V3_POLICY = "true";
    process.env.JUDGE_V3_PUSH_BUDGET = "1";
    seed();
    for (const id of ["e1", "e2", "e3"]) {
      judgedAs("PUSH");
      expect(await judge(id)).toBe("PUSH");
    }
    expect(sendPushNotification).toHaveBeenCalledTimes(3);
    expect(slotKeys()).toEqual([]);
    expect(item("e1")?.v3PolicyVersion ?? null).toBeNull();
  });
});

describe("JUDGE_V3_POLICY on, for a user under the policy", () => {
  beforeEach(() => {
    process.env.JUDGE_V3_POLICY = "true";
    process.env.JUDGE_V3_SHADOW = "true";
  });

  it("sends at most the budget per local day, then holds the rest in QUEUE", async () => {
    process.env.JUDGE_V3_PUSH_BUDGET = "2";
    seed({ timezone: "Asia/Seoul" });
    const shown = [];
    for (const id of IDS.slice(0, 4)) {
      judgedAs("PUSH");
      shown.push(await judge(id));
    }
    expect(shown).toEqual(["PUSH", "PUSH", "QUEUE", "QUEUE"]);
    expect(sendPushNotification).toHaveBeenCalledTimes(2);
    expect(slotKeys()).toEqual(["interrupt:2026-11-01:1", "interrupt:2026-11-01:2"]);
    for (const id of ["e3", "e4"]) {
      // Written held: QUEUE with heldAt, never PUSH first.
      expect(item(id)).toMatchObject({
        tier: "QUEUE",
        tierReason: HELD_REASON_KEY,
        heldAt: NOW,
        v3PolicyVersion: "v2",
      });
      const reasons = (item(id)?.v3Decision as { reasons: { code: string; params: unknown }[] })
        .reasons;
      expect(reasons[0]).toMatchObject({ code: "held_budget", params: { budget: 2 } });
      // decidedBy keeps the judge path (the fallback repair sweep selects on it).
      expect(label(id)).toMatchObject({ shownTier: "QUEUE", decidedBy: "llm" });
    }
    expect(item("e1")).toMatchObject({ tier: "PUSH", heldAt: null, v3PolicyVersion: "v2" });
    // Gmail label mode follows what the item shows.
    expect(vi.mocked(applyLaneLabel).mock.calls.map((c) => c[2])).toEqual([
      "PUSH",
      "PUSH",
      "QUEUE",
      "QUEUE",
    ]);
  });

  it("defaults to the founder's 5 per day", async () => {
    seed();
    for (const id of IDS) {
      judgedAs("PUSH");
      await judge(id);
    }
    expect(sendPushNotification).toHaveBeenCalledTimes(5);
    expect(item("e6")?.tier).toBe("QUEUE");
  });

  it("counts slots already spent today, and a new local day starts fresh", async () => {
    process.env.JUDGE_V3_PUSH_BUDGET = "1";
    seed({
      timezone: "Asia/Seoul",
      notification: [
        {
          id: "yesterday",
          userId: USER,
          type: "email",
          title: "Urgent email",
          message: "x [g-old]",
          dedupeKey: "interrupt:2026-10-31:1",
          createdAt: new Date(NOW.getTime() - 2 * HOUR),
        },
      ],
    });
    judgedAs("PUSH");
    expect(await judge("e1")).toBe("PUSH");
    judgedAs("PUSH");
    expect(await judge("e2")).toBe("QUEUE");
  });

  it("does not budget MEETING notifications", async () => {
    process.env.JUDGE_V3_PUSH_BUDGET = "1";
    seed();
    judgedAs("PUSH");
    await judge("e1");
    judgedAs("MEETING");
    expect(await judge("e2")).toBe("MEETING");
    judgedAs("MEETING");
    await judge("e3");
    expect(sendPushNotification).toHaveBeenCalledTimes(3);
    expect(slotKeys()).toHaveLength(1);
  });

  it("runs the 6h recency rule and the dedupe first: neither spends budget", async () => {
    process.env.JUDGE_V3_PUSH_BUDGET = "1";
    seed({
      notification: [
        {
          id: "earlier-push",
          userId: USER,
          type: "email",
          title: "Urgent email",
          message: "Alice: Subject e2 [g-e2]",
          createdAt: new Date(NOW.getTime() - HOUR),
        },
      ],
    });
    judgedAs("PUSH");
    expect(await judge("e1", { receivedAt: new Date(NOW.getTime() - 7 * HOUR) })).toBe("PUSH");
    judgedAs("PUSH");
    expect(await judge("e2")).toBe("PUSH");
    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(slotKeys()).toEqual([]);

    judgedAs("PUSH");
    expect(await judge("e3")).toBe("PUSH");
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
  });

  it("a sender the user pinned to PUSH always rings and spends no budget", async () => {
    process.env.JUDGE_V3_PUSH_BUDGET = "1";
    seed();
    for (const id of ["e1", "e2", "e3"]) {
      judgedAs("PUSH", "pinned-rule");
      expect(await judge(id)).toBe("PUSH");
    }
    expect(slotKeys()).toEqual([]);
    judgedAs("PUSH");
    expect(await judge("e4")).toBe("PUSH");
    expect(sendPushNotification).toHaveBeenCalledTimes(4);
    expect(slotKeys()).toHaveLength(1);
  });

  it("a push that will not ring (quiet hours) spends no budget", async () => {
    process.env.JUDGE_V3_PUSH_BUDGET = "1";
    // 00:30 in Seoul is inside 22:00–08:00.
    seed({ config: { quietHoursStart: "22:00", quietHoursEnd: "08:00" } });
    for (const id of ["e1", "e2", "e3"]) {
      judgedAs("PUSH");
      expect(await judge(id)).toBe("PUSH");
    }
    expect(slotKeys()).toEqual([]);
    expect(db.tables.notification ?? []).toHaveLength(3);
  });

  it("a slot row the user cleared from the bell still dedupes the same mail", async () => {
    seed({
      notification: [
        {
          id: "cleared-slot",
          userId: USER,
          type: "claim",
          title: "Urgent email",
          message: "Alice: Subject e1 [g-e1]",
          dedupeKey: "interrupt:2026-11-01:1",
          isRead: true,
          createdAt: new Date(NOW.getTime() - HOUR),
        },
      ],
    });
    judgedAs("PUSH");
    await judge("e1");
    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(slotKeys()).toEqual(["interrupt:2026-11-01:1"]);
  });

  it("a re-judge that lost to a human sends nothing, keeps their lane and hides the claimed row", async () => {
    process.env.JUDGE_V3_PUSH_BUDGET = "1";
    seed(
      {
        attentionItem: [
          {
            id: "item-e2",
            userId: USER,
            source: "EMAIL",
            sourceId: "e2",
            type: "REPLY_NEEDED",
            title: "Subject e2",
            tier: "QUEUE",
          },
        ],
      },
      {
        beforeUpdateMany: (model) => {
          if (model !== "attentionItem") return;
          for (const row of db.tables.attentionItem ?? []) {
            if (row.sourceId === "e2")
              Object.assign(row, { tier: "SILENT", isManualOverride: true });
          }
        },
      },
    );
    judgedAs("PUSH");
    await judge("e2", {}, { rejudge: true });
    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(item("e2")).toMatchObject({ tier: "SILENT", isManualOverride: true });
    // The slot stays spent; its bell row is hidden like a cleared slot row.
    expect(slotKeys()).toEqual(["interrupt:2026-11-01:1"]);
    expect(db.tables.notification?.[0]).toMatchObject({ type: "claim", isRead: true });
  });

  it("a held item stays held when a re-judge says PUSH again", async () => {
    process.env.JUDGE_V3_PUSH_BUDGET = "1";
    seed();
    judgedAs("PUSH");
    await judge("e1");
    judgedAs("PUSH");
    expect(await judge("e2")).toBe("QUEUE");
    vi.setSystemTime(new Date(NOW.getTime() + HOUR));
    judgedAs("PUSH");
    expect(await judge("e2", {}, { rejudge: true })).toBe("QUEUE");
    expect(item("e2")).toMatchObject({ tier: "QUEUE", heldAt: NOW, tierReason: HELD_REASON_KEY });
    expect(slotKeys()).toHaveLength(1);
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
  });

  it("the user's own budget overrides the system default", async () => {
    process.env.JUDGE_V3_PUSH_BUDGET = "5";
    seed({ config: { interruptBudget: 1 } });
    judgedAs("PUSH");
    expect(await judge("e1")).toBe("PUSH");
    judgedAs("PUSH");
    expect(await judge("e2")).toBe("QUEUE");
  });

  it("strangers stop at their share; a sender the user wrote to still gets a reserved slot", async () => {
    seed();
    loadRelationshipSnapshot.mockImplementation(async (input: { senderAddress: string }) =>
      input.senderAddress.includes("bob@") ? TRUSTED : { ...UNKNOWN_RELATIONSHIP },
    );
    const shown = [];
    for (const id of ["e1", "e2", "e3", "e4"]) {
      judgedAs("PUSH");
      shown.push(await judge(id, { from: `Stranger <s-${id}@example.net>` }));
    }
    // Default 5 per day, 2 reserved: three strangers ring, the fourth is held.
    expect(shown).toEqual(["PUSH", "PUSH", "PUSH", "QUEUE"]);
    judgedAs("PUSH");
    expect(await judge("e5", { from: "Bob <bob@example.com>" })).toBe("PUSH");
    expect(sendPushNotification).toHaveBeenCalledTimes(4);
  });

  it("concurrent judgements never exceed the budget", async () => {
    process.env.JUDGE_V3_PUSH_BUDGET = "2";
    seed();
    for (let i = 0; i < IDS.length; i++) judgedAs("PUSH");
    const shown = await Promise.all(IDS.map((id) => judge(id)));
    // The invariant is on what was admitted: shown lanes, slots and bell rows.
    // Delivery counts are asserted in the sequential cases above (lazy imports
    // racing under vi.mock make the per-call mock count unreliable here).
    expect(shown.filter((t) => t === "PUSH")).toHaveLength(2);
    expect(slotKeys()).toHaveLength(2);
    expect(db.tables.notification ?? []).toHaveLength(2);
    expect(
      (db.tables.attentionItem ?? []).filter((r) => r.tierReason === HELD_REASON_KEY),
    ).toHaveLength(4);
  });
});

describe("lanes from facts, for a user under the policy", () => {
  beforeEach(() => {
    process.env.JUDGE_V3_POLICY = "true";
    process.env.JUDGE_V3_SHADOW = "true";
  });

  it("new mail: live LLM facts decide the lane before the item is written", async () => {
    seed();
    // v2 said PUSH; the facts say a promotion to a list. Nothing rings.
    judgedAs("PUSH");
    extractFactsForDecision.mockResolvedValueOnce(
      liveFacts(facts({ kind: "promotion", addressedTo: "bulk" })),
    );
    expect(await judge("e1", {}, { liveRaw: raw("e1") })).toBe("SILENT");
    expect(item("e1")).toMatchObject({
      tier: "SILENT",
      tierReason: V3_LANE_REASON_KEY,
      v3PolicyVersion: POLICY_VERSION,
      heldAt: null,
    });
    expect(label("e1")).toMatchObject({ shownTier: "SILENT", decidedBy: "llm" });

    // v2 said QUEUE; the facts carry an ask due in 2h addressed to the user.
    judgedAs("QUEUE");
    extractFactsForDecision.mockResolvedValueOnce(liveFacts(dueSoon()));
    expect(await judge("e2", {}, { liveRaw: raw("e2") })).toBe("PUSH");
    expect(item("e2")?.v3Due).toEqual(new Date(NOW.getTime() + 2 * HOUR));
    expect(slotKeys()).toEqual(["interrupt:2026-11-01:1"]);
    expect(sendPushNotification).toHaveBeenCalledTimes(1);

    const [, mail, opts] = extractFactsForDecision.mock.calls[0] as [
      string,
      { emailId: string },
      { v2Tier: string; deadlineMs: number },
    ];
    expect(mail.emailId).toBe("e1");
    expect(opts).toMatchObject({ v2Tier: "PUSH", deadlineMs: 20_000 });
  });

  it("no LLM facts (timeout) keeps the v2 lane, still under the budget", async () => {
    process.env.JUDGE_V3_PUSH_BUDGET = "1";
    seed();
    extractFactsForDecision.mockResolvedValue({ status: "timeout" });
    judgedAs("PUSH");
    expect(await judge("e1", {}, { liveRaw: raw("e1") })).toBe("PUSH");
    judgedAs("PUSH");
    expect(await judge("e2", {}, { liveRaw: raw("e2") })).toBe("QUEUE");
    expect(item("e1")).toMatchObject({ v3PolicyVersion: "v2", tierReason: "Urgent" });
  });

  it("a precedence source decides without a facts call", async () => {
    seed();
    judgedAs("PUSH", "pinned-rule");
    await judge("e1", {}, { liveRaw: raw("e1") });
    expect(extractFactsForDecision).not.toHaveBeenCalled();
    const reasons = (item("e1")?.v3Decision as { reasons: { code: string }[] }).reasons;
    expect(reasons.map((r) => r.code)).toEqual(["pinned"]);
  });

  it("a re-judge reads the stored facts and makes no model call", async () => {
    seed({
      attentionFacts: [
        {
          id: "f1",
          userId: USER,
          source: "EMAIL",
          sourceId: "e1",
          factsVersion: FACTS_VERSION,
          factsSource: "llm",
          extractedAt: NOW,
          facts: facts({ kind: "notification", addressedTo: "me_direct" }),
          certainFields: [],
          evidenceCheck: { checked: 0, dropped: [] },
          relationship: TRUSTED,
        },
      ],
    });
    judgedAs("PUSH");
    expect(await judge("e1")).toBe("INFO");
    expect(extractFactsForDecision).not.toHaveBeenCalled();
    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(item("e1")).toMatchObject({ tier: "INFO", v3PolicyVersion: POLICY_VERSION });
  });
});

describe("ordering and failure paths, for a user under the policy", () => {
  beforeEach(() => {
    process.env.JUDGE_V3_POLICY = "true";
    process.env.JUDGE_V3_SHADOW = "true";
  });

  const heldItem = (id: string): Row => ({
    id: `item-${id}`,
    userId: USER,
    source: "EMAIL",
    sourceId: id,
    type: "REPLY_NEEDED",
    title: `Subject ${id}`,
    tier: "QUEUE",
    tierReason: HELD_REASON_KEY,
    heldAt: new Date(NOW.getTime() - HOUR),
  });

  it("a plan that fails still writes the mail, in v2's lane, and rings nothing", async () => {
    seed();
    extractFactsForDecision.mockRejectedValueOnce(new Error("database unavailable"));
    judgedAs("PUSH");
    expect(await judge("e1", {}, { liveRaw: raw("e1") })).toBe("PUSH");
    expect(item("e1")).toMatchObject({ tier: "PUSH", v3PolicyVersion: null });
    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(slotKeys()).toEqual([]);
  });

  it("a write that throws after a claim releases the slot, so the retry can ring", async () => {
    seed(
      { attentionItem: [{ ...heldItem("e1"), tier: "QUEUE", tierReason: "x", heldAt: null }] },
      {
        beforeUpdateMany: (model) => {
          if (model === "attentionItem") throw new Error("write failed");
        },
      },
    );
    judgedAs("PUSH");
    await expect(judge("e1", {}, { rejudge: true })).rejects.toThrow("write failed");
    expect(db.tables.notification ?? []).toEqual([]);
    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("a pin added after a hold keeps its precedence: the re-judge rings and clears the hold", async () => {
    seed({ attentionItem: [heldItem("e1")] });
    judgedAs("PUSH", "pinned-rule");
    expect(await judge("e1", {}, { rejudge: true })).toBe("PUSH");
    expect(item("e1")).toMatchObject({ tier: "PUSH", heldAt: null });
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
  });

  it("a re-judge to another lane clears the hold", async () => {
    seed({ attentionItem: [heldItem("e1")] });
    judgedAs("MEETING");
    expect(await judge("e1", {}, { rejudge: true })).toBe("MEETING");
    expect(item("e1")).toMatchObject({ tier: "MEETING", heldAt: null });
  });

  it("v2's autoEligible survives only where v3 kept the lane and saw no risk", async () => {
    seed();
    const eligibleQueue = () =>
      judgeEmail.mockResolvedValueOnce({
        tier: "QUEUE",
        reason: "Reply when you can",
        features: { confidence: 0.9, senderTrust: 0.8, reversibility: 0.5, urgency: 0.3 },
        source: "llm",
        autoEligible: true,
      });
    eligibleQueue();
    extractFactsForDecision.mockResolvedValueOnce(
      liveFacts(facts({ threadTurn: "mine_to_reply" })),
    );
    await judge("e1", {}, { liveRaw: raw("e1") });
    expect(item("e1")).toMatchObject({ tier: "QUEUE", autoEligible: true });

    // A payment risk keeps QUEUE, but unattended auto mode must not answer it.
    eligibleQueue();
    extractFactsForDecision.mockResolvedValueOnce(
      liveFacts(facts({ risk: ["payment_failed"], kind: "notification" })),
    );
    await judge("e2", {}, { liveRaw: raw("e2") });
    expect(item("e2")).toMatchObject({ tier: "QUEUE", autoEligible: false });
  });

  it("a hold does not mask a lane change: v3 said PUSH, so autoEligible drops though QUEUE is written", async () => {
    process.env.JUDGE_V3_PUSH_BUDGET = "1";
    seed();
    judgedAs("PUSH");
    await judge("e1");
    judgeEmail.mockResolvedValueOnce({
      tier: "QUEUE",
      reason: "Reply when you can",
      features: { confidence: 0.9, senderTrust: 0.8, reversibility: 0.5, urgency: 0.3 },
      source: "llm",
      autoEligible: true,
    });
    extractFactsForDecision.mockResolvedValueOnce(liveFacts(dueSoon()));
    expect(await judge("e2", {}, { liveRaw: raw("e2") })).toBe("QUEUE");
    expect(item("e2")).toMatchObject({
      tier: "QUEUE",
      tierReason: HELD_REASON_KEY,
      autoEligible: false,
    });
  });

  it("the backfill sweep leaves mail younger than five minutes to the inline judge", async () => {
    seed();
    for (const row of db.tables.emailMessage ?? []) {
      Object.assign(row, {
        receivedAt: new Date(NOW.getTime() - HOUR),
        createdAt: row.id === "e1" ? new Date(NOW.getTime() - 10 * 60_000) : NOW,
        labels: ["INBOX"],
        snippet: "",
      });
    }
    judgeEmail.mockResolvedValue({
      tier: "QUEUE",
      reason: "r",
      features: { confidence: 0.9, senderTrust: 0.8, reversibility: 0.5, urgency: 0.3 },
      source: "llm",
      autoEligible: false,
    });
    await backfillEmailAttentionItems(USER);
    expect((db.tables.attentionItem ?? []).map((r) => r.sourceId)).toEqual(["e1"]);
  });
});
