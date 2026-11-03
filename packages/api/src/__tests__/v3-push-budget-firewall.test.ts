/**
 * The live PUSH interrupt budget on the firewall push path
 * (docs/design/attention-engine-v3.md §3(4), JUDGE_V3_POLICY).
 *
 * The real judgeAndMirrorEmail runs over the in-memory database; only the
 * judge and the outward-facing notifiers are mocked. Covers: the budget is
 * never exceeded, a held item lands QUEUE with the held reason and no
 * notification, MEETING is not budgeted, the existing 6h and dedupe gates run
 * first and spend no budget, and the flag-off path is unchanged.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const judgeEmail = vi.hoisted(() => vi.fn());
const sendPushNotification = vi.hoisted(() => vi.fn(async () => ({})));

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
vi.mock("../notify/notification-strings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../notify/notification-strings.js")>()),
  getUserNotificationLanguage: vi.fn(async () => "en"),
}));
vi.mock("../notify/push.js", () => ({ sendPushNotification }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../notify/conversations-updated.js", () => ({ notifyConversationsUpdated: vi.fn() }));
vi.mock("../mail/gmail-labels.js", () => ({
  applyLaneLabel: vi.fn(async () => "applied"),
  isLabelModeEnabled: () => false,
  laneForLabelIds: vi.fn(async () => null),
}));

import { judgeAndMirrorEmail } from "../judge/email-firewall.js";
import { HELD_REASON_KEY } from "../judge/v3/push-budget-gate.js";
import { applyLaneLabel } from "../mail/gmail-labels.js";

const USER = "user-1";
// 00:30 in Seoul: the budget day is 2026-11-01 there, still 2026-10-31 in UTC.
const NOW = new Date("2026-10-31T15:30:00.000Z");
const HOUR = 60 * 60_000;
const IDS = ["e1", "e2", "e3", "e4", "e5", "e6"];

let db: FakeDb;

function seed(
  extra: { notification?: Row[]; timezone?: string; config?: Row } = {},
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
      attentionItem: [],
      decisionLabel: [],
      notification: extra.notification ?? [],
      automationConfig: config,
      user: [],
    },
    hooks,
  );
  dbHolder.current = db;
}

function judgedAs(tier: "PUSH" | "MEETING", source = "llm") {
  judgeEmail.mockResolvedValueOnce({
    tier,
    reason: "Urgent",
    features: { confidence: 0.9, senderTrust: 0.8, reversibility: 0.5, urgency: 0.9 },
    source,
    autoEligible: false,
  });
}

const judge = (id: string, over: { receivedAt?: Date } = {}) =>
  judgeAndMirrorEmail(USER, {
    id,
    gmailId: `g-${id}`,
    from: "Alice <alice@example.com>",
    subject: `Subject ${id}`,
    snippet: "Please sign today",
    labels: ["INBOX"],
    receivedAt: new Date(NOW.getTime() - 60_000),
    linkedInboxAccountId: null,
    ...over,
  });

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
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.JUDGE_V3_POLICY;
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

describe("JUDGE_V3_POLICY on", () => {
  beforeEach(() => {
    process.env.JUDGE_V3_POLICY = "true";
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
      expect(item(id)).toMatchObject({ tier: "QUEUE", tierReason: HELD_REASON_KEY });
      // decidedBy keeps the judge path (the fallback repair sweep selects on it).
      expect(label(id)).toMatchObject({ shownTier: "QUEUE", decidedBy: "llm" });
    }
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

  it("sends nothing and keeps a human's lane when the item changed before the hold", async () => {
    process.env.JUDGE_V3_PUSH_BUDGET = "1";
    seed(
      {},
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
    await judge("e1");
    judgedAs("PUSH");
    await judge("e2");
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
    expect(item("e2")).toMatchObject({ tier: "SILENT", isManualOverride: true });
    expect(label("e2")?.shownTier).toBe("PUSH");
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
