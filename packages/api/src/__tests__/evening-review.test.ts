/**
 * Evening review (eod_review): sends only when something is still open.
 * In production nearly every evening send was "0 tasks completed. Tomorrow
 * looks clear." — these pin that an empty evening sends nothing, what counts
 * as open, and that the copy follows the notification language.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  mails: [] as Array<Record<string, unknown>>,
  attention: [] as Array<Record<string, unknown>>,
  engaged: [] as Array<Record<string, unknown>>,
  commitments: [] as Array<Record<string, unknown>>,
  briefs: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  notificationLanguage: null as string | null,
  existingReview: null as Record<string, unknown> | null,
  created: [] as Array<{ data: Record<string, unknown> }>,
  mailWhere: [] as Array<Record<string, unknown>>,
  commitmentWhere: [] as Array<Record<string, unknown>>,
}));

vi.mock("../db.js", () => {
  const handlers: Record<string, Record<string, (args: Record<string, unknown>) => unknown>> = {
    emailMessage: {
      findMany: (args) => {
        m.mailWhere.push(args.where as Record<string, unknown>);
        return m.mails;
      },
    },
    attentionItem: { findMany: () => m.attention },
    decisionLabel: { findMany: () => m.engaged },
    commitment: {
      findMany: (args) => {
        m.commitmentWhere.push(args.where as Record<string, unknown>);
        return m.commitments;
      },
    },
    threadBrief: { findMany: () => m.briefs },
    calendarEvent: { findMany: () => m.events },
    automationConfig: {
      findUnique: () => ({ timezone: "Asia/Seoul", notificationLanguage: m.notificationLanguage }),
    },
    notification: {
      findFirst: (args) => {
        const where = args.where as { type?: string };
        return where.type === "eod_review" ? m.existingReview : null;
      },
      create: (args) => {
        m.created.push(args as { data: Record<string, unknown> });
        return { id: "n1", createdAt: new Date("2099-01-05T09:05:00Z") };
      },
    },
  };
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) =>
          vi.fn(async (args: Record<string, unknown> = {}) => {
            const handler = handlers[name]?.[method];
            if (handler) return handler(args);
            if (method === "findMany") return [];
            if (method === "count") return 0;
            return null;
          }),
      },
    );
  const prisma = new Proxy({}, { get: (_t, name: string) => model(name) });
  return { prisma, db: prisma };
});
vi.mock("../notify/push.js", () => ({ sendPushNotification: vi.fn(async () => undefined) }));
vi.mock("../notify/sms.js", () => ({ sendSms: vi.fn(async () => undefined) }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import {
  composeEveningReview,
  type EveningReviewInput,
  gatherEveningReviewInput,
} from "../agentcore/evening-review.js";
import { runProactiveActions } from "../agentcore/proactive-actions.js";

const TZ = "Asia/Seoul";
/** 18:05 KST on 2099-01-05: inside the 18:00 evening window. */
const EVENING = new Date("2099-01-05T09:05:00Z");
/** 2099-01-06 08:30 KST — before 10:00 local. */
const EARLY_TOMORROW = new Date("2099-01-05T23:30:00Z");
/** 2099-01-06 14:00 KST. */
const LATE_TOMORROW = new Date("2099-01-06T05:00:00Z");

const EMPTY: EveningReviewInput = {
  unanswered: [],
  commitments: [],
  theyOwe: [],
  firstMeetingTomorrow: null,
};

function mail(id: string, extra: Record<string, unknown> = {}) {
  return { id, from: `Sender ${id} <${id}@example.com>`, subject: `Subject ${id}`, ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.mails = [];
  m.attention = [];
  m.engaged = [];
  m.commitments = [];
  m.briefs = [];
  m.events = [];
  m.notificationLanguage = null;
  m.existingReview = null;
  m.created = [];
  m.mailWhere = [];
  m.commitmentWhere = [];
});

describe("composeEveningReview", () => {
  it("returns nothing for an empty evening — the 'Tomorrow looks clear' push is gone", () => {
    expect(composeEveningReview(EMPTY, "en", TZ)).toBeNull();
  });

  it("returns nothing when tomorrow's only meeting starts at or after 10:00 local", () => {
    const input = { ...EMPTY, firstMeetingTomorrow: { title: "Sync", startTime: LATE_TOMORROW } };
    expect(composeEveningReview(input, "en", TZ)).toBeNull();
  });

  it("sends for an early meeting alone, titled as an early start", () => {
    const input = {
      ...EMPTY,
      firstMeetingTomorrow: { title: "Standup", startTime: EARLY_TOMORROW },
    };
    const review = composeEveningReview(input, "en", TZ);
    expect(review?.title).toBe("Early start tomorrow");
    expect(review?.message).toBe("Tomorrow starts at 8:30 AM: Standup");
  });

  it("names open items with counts and adds tomorrow's first meeting alongside", () => {
    const input: EveningReviewInput = {
      unanswered: [mail("a"), mail("b")],
      commitments: [{ title: "Send the deck", overdue: true }],
      theyOwe: ["Sarah: signed contract"],
      firstMeetingTomorrow: { title: "Review", startTime: LATE_TOMORROW },
    };
    const review = composeEveningReview(input, "en", TZ);
    expect(review?.title).toBe("4 things still open today");
    expect(review?.message.split("\n")).toEqual([
      "Unanswered today (2)",
      "• Sender a — Subject a",
      "• Sender b — Subject b",
      "Due today or overdue (1)",
      "• Send the deck (overdue)",
      "Waiting on others (1)",
      "• Sarah: signed contract",
      "Tomorrow starts at 2:00 PM: Review",
    ]);
  });

  it("names at most three items per section while the header keeps the full count", () => {
    const input = { ...EMPTY, unanswered: ["a", "b", "c", "d", "e"].map((id) => mail(id)) };
    const lines = composeEveningReview(input, "en", TZ)?.message.split("\n") ?? [];
    expect(lines[0]).toBe("Unanswered today (5)");
    expect(lines.filter((l) => l.startsWith("• "))).toHaveLength(3);
  });

  it("writes Korean copy for a Korean notification language", () => {
    const input = {
      ...EMPTY,
      commitments: [{ title: "계약서 보내기", overdue: false }],
      firstMeetingTomorrow: { title: "주간 회의", startTime: EARLY_TOMORROW },
    };
    const review = composeEveningReview(input, "ko", TZ);
    expect(review?.title).toBe("오늘 아직 남은 일 1건");
    expect(review?.message).toContain("오늘 마감이거나 기한 지남 (1)");
    expect(review?.message).toContain("내일 첫 일정 오전 8:30: 주간 회의");
    expect(review?.message).not.toMatch(/Tomorrow|Due today/);
  });

  it("has copy for every shipped language", () => {
    const input = { ...EMPTY, theyOwe: ["x"] };
    for (const lang of ["en", "ko", "ja", "zh", "es", "fr", "de"] as const) {
      const review = composeEveningReview(input, lang, TZ);
      expect(review?.title.length).toBeGreaterThan(0);
      expect(review?.message).toContain("• x");
    }
  });
});

describe("gatherEveningReviewInput", () => {
  it("keeps today's PUSH and needs-reply mail that nobody answered, archived or settled", async () => {
    m.mails = [
      mail("needs-reply", { needsReply: true }),
      mail("push", { needsReply: false }),
      mail("queue", { needsReply: false }),
      mail("replied-in-gmail", { needsReply: true }),
      mail("dismissed-item", { needsReply: true }),
      mail("legacy-call", { needsReply: false }),
    ];
    m.attention = [
      { sourceId: "push", tier: "PUSH", status: "OPEN" },
      { sourceId: "queue", tier: "QUEUE", status: "OPEN" },
      { sourceId: "dismissed-item", tier: "QUEUE", status: "DISMISSED" },
      { sourceId: "legacy-call", tier: "CALL", status: "OPEN" },
    ];
    m.engaged = [{ sourceId: "replied-in-gmail" }];

    const input = await gatherEveningReviewInput("u1", TZ, EVENING);

    expect(input.unanswered.map((x) => x.id)).toEqual(["needs-reply", "push", "legacy-call"]);
    // Today in the user's zone, and never a mail Klorn already answered.
    expect(m.mailWhere[0]).toMatchObject({
      userId: "u1",
      repliedAt: null,
      receivedAt: {
        gte: new Date("2099-01-04T15:00:00Z"),
        lt: new Date("2099-01-05T15:00:00Z"),
      },
    });
  });

  it("splits commitments into what the user owes and what the other side owes, bounded to a week overdue", async () => {
    m.commitments = [
      { title: "Send the deck", dueAt: new Date("2099-01-05T02:00:00Z"), owner: "USER" },
      { title: "Review the PR", dueAt: new Date("2099-01-05T12:00:00Z"), owner: "TEAM" },
      {
        title: "Signed contract",
        dueAt: new Date("2099-01-05T03:00:00Z"),
        owner: "COUNTERPARTY",
        counterpartyName: "Sarah",
        threadId: "t1",
      },
    ];
    m.briefs = [
      { threadId: "t1", theyOwe: "Sarah owes the signed contract" },
      { threadId: "t2", theyOwe: "Budget numbers from finance" },
    ];

    const input = await gatherEveningReviewInput("u1", TZ, EVENING);

    expect(input.commitments).toEqual([
      { title: "Send the deck", overdue: true },
      { title: "Review the PR", overdue: false },
    ]);
    // The brief on the same thread as the commitment is not listed twice.
    expect(input.theyOwe).toEqual(["Sarah: Signed contract", "Budget numbers from finance"]);
    expect(m.commitmentWhere[0]).toMatchObject({
      status: "OPEN",
      dueAt: { gte: new Date("2098-12-28T15:00:00Z"), lt: new Date("2099-01-05T15:00:00Z") },
    });
  });

  it("picks tomorrow's first timed meeting and skips a zero-length row", async () => {
    m.events = [
      {
        id: "e0",
        title: "Note row",
        startTime: EARLY_TOMORROW,
        endTime: EARLY_TOMORROW,
        provider: "GOOGLE",
        externalId: "g0",
        sourceAccountId: null,
      },
      {
        id: "e1",
        title: "Standup",
        startTime: LATE_TOMORROW,
        endTime: new Date(LATE_TOMORROW.getTime() + 30 * 60 * 1000),
        provider: "GOOGLE",
        externalId: "g1",
        sourceAccountId: null,
      },
    ];

    const input = await gatherEveningReviewInput("u1", TZ, EVENING);

    expect(input.firstMeetingTomorrow).toEqual({ title: "Standup", startTime: LATE_TOMORROW });
  });
});

describe("end-of-day review in the proactive loop", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(EVENING);
  });

  function reviews() {
    return m.created.filter((c) => c.data.type === "eod_review");
  }

  it("sends nothing on an empty evening", async () => {
    await runProactiveActions("u1");
    expect(reviews()).toHaveLength(0);
  });

  it("sends once there is an unanswered needs-reply mail, in the user's language", async () => {
    m.notificationLanguage = "ko";
    m.mails = [mail("a", { needsReply: true })];

    await runProactiveActions("u1");

    expect(reviews()).toHaveLength(1);
    expect(reviews()[0]?.data).toMatchObject({
      title: "오늘 아직 남은 일 1건",
      link: "/briefing",
    });
    expect(String(reviews()[0]?.data.message)).toContain("오늘 답장하지 않은 메일 (1)");
  });

  it("does not send a second review the same evening", async () => {
    m.mails = [mail("a", { needsReply: true })];
    m.existingReview = { id: "earlier" };

    await runProactiveActions("u1");

    expect(reviews()).toHaveLength(0);
  });

  it("stays quiet outside the evening window", async () => {
    vi.setSystemTime(new Date("2099-01-05T03:00:00Z")); // 12:00 KST
    m.mails = [mail("a", { needsReply: true })];

    await runProactiveActions("u1");

    expect(reviews()).toHaveLength(0);
  });
});
