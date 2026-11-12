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
  labels: [] as Array<Record<string, unknown>>,
  sent: [] as Array<Record<string, unknown>>,
  commitments: [] as Array<Record<string, unknown>>,
  briefs: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  notificationLanguage: null as string | null,
  existingReview: null as Record<string, unknown> | null,
  created: [] as Array<{ data: Record<string, unknown> }>,
  where: {} as Record<string, Array<Record<string, unknown>>>,
}));

vi.mock("../db.js", () => {
  const rows: Record<string, () => unknown> = {
    emailMessage: () => m.mails,
    attentionItem: () => m.attention,
    decisionLabel: () => m.labels,
    sentMessage: () => m.sent,
    commitment: () => m.commitments,
    threadBrief: () => m.briefs,
    calendarEvent: () => m.events,
  };
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) =>
          vi.fn(async (args: Record<string, unknown> = {}) => {
            if (method === "findMany" && rows[name]) {
              m.where[name] = [...(m.where[name] ?? []), args.where as Record<string, unknown>];
              return rows[name]();
            }
            if (name === "automationConfig" && method === "findUnique") {
              return { timezone: "Asia/Seoul", notificationLanguage: m.notificationLanguage };
            }
            if (name === "notification" && method === "findFirst") {
              const where = args.where as { type?: string };
              return where.type === "eod_review" ? m.existingReview : null;
            }
            if (name === "notification" && method === "create") {
              m.created.push(args as { data: Record<string, unknown> });
              return { id: "n1", createdAt: new Date("2099-01-05T09:05:00Z") };
            }
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
import { sendPushNotification } from "../notify/push.js";

const TZ = "Asia/Seoul";
/** 18:05 KST on 2099-01-05: inside the 18:00 evening window. */
const EVENING = new Date("2099-01-05T09:05:00Z");
/** 2099-01-06 08:30 KST — before 10:00 local. */
const EARLY_TOMORROW = new Date("2099-01-05T23:30:00Z");
/** 2099-01-06 14:00 KST. */
const LATE_TOMORROW = new Date("2099-01-06T05:00:00Z");
const MINUTE = 60 * 1000;

const EMPTY: EveningReviewInput = {
  unanswered: [],
  commitments: [],
  theyOwe: [],
  firstMeetingTomorrow: null,
};

function mail(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    from: `Sender ${id} <${id}@example.com>`,
    subject: `Subject ${id}`,
    needsReply: false,
    isRead: false,
    threadId: null,
    receivedAt: new Date("2099-01-05T01:00:00Z"),
    repliedAt: null,
    ...extra,
  };
}

function event(id: string, start: Date, minutes: number) {
  return {
    id,
    title: `Event ${id}`,
    startTime: start,
    endTime: new Date(start.getTime() + minutes * MINUTE),
    provider: "GOOGLE",
    externalId: `g-${id}`,
    sourceAccountId: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.mails = [];
  m.attention = [];
  m.labels = [];
  m.sent = [];
  m.commitments = [];
  m.briefs = [];
  m.events = [];
  m.notificationLanguage = null;
  m.existingReview = null;
  m.created = [];
  m.where = {};
});

describe("composeEveningReview", () => {
  it("returns nothing for an empty evening — the 'Tomorrow looks clear' push is gone", () => {
    expect(composeEveningReview(EMPTY, "en", TZ)).toBeNull();
  });

  it("returns nothing when tomorrow's only meeting starts at 10:00 local or later", () => {
    const tenSharp = new Date("2099-01-06T01:00:00Z"); // 10:00 KST
    const input = { ...EMPTY, firstMeetingTomorrow: { title: "Sync", startTime: tenSharp } };
    expect(composeEveningReview(input, "en", TZ)).toBeNull();
  });

  it("sends for a meeting at 09:59 local alone, titled as an early start", () => {
    const early = new Date("2099-01-06T00:59:00Z"); // 09:59 KST
    const input = { ...EMPTY, firstMeetingTomorrow: { title: "Standup", startTime: early } };
    const review = composeEveningReview(input, "en", TZ);
    expect(review?.title).toBe("Early start tomorrow");
    expect(review?.message).toBe("Tomorrow starts at 9:59 AM: Standup");
    expect(review?.pushBody).toBe("Tomorrow starts at 9:59 AM: Standup");
  });

  it("reads the early-start hour in the user's zone, across a DST change", () => {
    // 2099-03-09 is the day after the US spring-forward: 13:30Z is 09:30 EDT.
    const early = new Date("2099-03-09T13:30:00Z");
    const input = { ...EMPTY, firstMeetingTomorrow: { title: "Standup", startTime: early } };
    expect(composeEveningReview(input, "en", "America/New_York")?.message).toBe(
      "Tomorrow starts at 9:30 AM: Standup",
    );
  });

  it("names open items with counts, adds tomorrow's first meeting, and keeps the push short", () => {
    const input: EveningReviewInput = {
      unanswered: [mail("a"), mail("b")],
      commitments: [{ title: "Send the deck", overdue: true }],
      theyOwe: ["Sarah: signed contract"],
      firstMeetingTomorrow: { title: "Review", startTime: LATE_TOMORROW },
    };
    const review = composeEveningReview(input, "en", TZ);
    expect(review?.title).toBe("4 things still open today");
    expect(review?.message.split("\n")).toEqual([
      "Today's mail still open (2)",
      "• Sender a — Subject a",
      "• Sender b — Subject b",
      "Due today or overdue (1)",
      "• Send the deck (overdue)",
      "Waiting on others (1)",
      "• Sarah: signed contract",
      "Tomorrow starts at 2:00 PM: Review",
    ]);
    expect(review?.pushBody).toBe(
      "Today's mail still open (2) · Due today or overdue (1) · Waiting on others (1)\n" +
        "Tomorrow starts at 2:00 PM: Review",
    );
  });

  it("names the one open item in the push when there is only one", () => {
    const review = composeEveningReview({ ...EMPTY, unanswered: [mail("a")] }, "en", TZ);
    expect(review?.pushBody).toBe("Sender a — Subject a");
  });

  it("names at most three items per section while the header keeps the full count", () => {
    const input = { ...EMPTY, unanswered: ["a", "b", "c", "d", "e"].map((id) => mail(id)) };
    const lines = composeEveningReview(input, "en", TZ)?.message.split("\n") ?? [];
    expect(lines[0]).toBe("Today's mail still open (5)");
    expect(lines.filter((l) => l.startsWith("• "))).toHaveLength(3);
  });

  it("strips bidirectional controls from text it did not write", () => {
    const input = { ...EMPTY, theyOwe: ["Pay ‮invoice"] };
    expect(composeEveningReview(input, "en", TZ)?.message).toContain("• Pay invoice");
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

describe("gatherEveningReviewInput — today's mail", () => {
  it("keeps needs-reply mail and unread PUSH mail; drops read PUSH, QUEUE and settled items", async () => {
    m.mails = [
      mail("needs-reply", { needsReply: true }),
      mail("push-unread"),
      mail("push-read", { isRead: true }),
      mail("queue"),
      mail("archived-in-gmail", { needsReply: true }),
      mail("dismissed-item", { needsReply: true }),
      mail("snoozed-push"),
      mail("legacy-call"),
    ];
    m.attention = [
      { sourceId: "push-unread", tier: "PUSH", status: "OPEN" },
      { sourceId: "push-read", tier: "PUSH", status: "OPEN" },
      { sourceId: "queue", tier: "QUEUE", status: "OPEN" },
      { sourceId: "dismissed-item", tier: "QUEUE", status: "DISMISSED" },
      { sourceId: "snoozed-push", tier: "PUSH", status: "SNOOZED" },
      { sourceId: "legacy-call", tier: "CALL", status: "OPEN" },
    ];
    m.labels = [{ sourceId: "archived-in-gmail", providerArchivedAt: new Date() }];

    const input = await gatherEveningReviewInput("u1", TZ, EVENING);

    expect(input.unanswered.map((x) => x.id)).toEqual([
      "needs-reply",
      "push-unread",
      "legacy-call",
    ]);
    expect(m.where.emailMessage?.[0]).toMatchObject({
      userId: "u1",
      receivedAt: {
        gte: new Date("2099-01-04T15:00:00Z"),
        lt: new Date("2099-01-05T15:00:00Z"),
      },
    });
    expect(m.where.attentionItem?.[0]).toMatchObject({ userId: "u1", source: "EMAIL" });
    expect(m.where.decisionLabel?.[0]).toMatchObject({ userId: "u1", source: "EMAIL" });
  });

  it("lists a thread once, by its newest mail", async () => {
    m.mails = [
      mail("newer", {
        needsReply: true,
        threadId: "t1",
        receivedAt: new Date("2099-01-05T05:00:00Z"),
      }),
      mail("older", {
        needsReply: true,
        threadId: "t1",
        receivedAt: new Date("2099-01-05T01:00:00Z"),
      }),
    ];

    const input = await gatherEveningReviewInput("u1", TZ, EVENING);

    expect(input.unanswered.map((x) => x.id)).toEqual(["newer"]);
  });

  it("drops a thread the user answered after its newest mail — Klorn, provider stamp or Sent folder", async () => {
    const at = (h: number) => new Date(Date.UTC(2099, 0, 5, h));
    m.mails = [
      mail("klorn-reply", {
        needsReply: true,
        threadId: "t1",
        receivedAt: at(2),
        repliedAt: at(3),
      }),
      mail("sibling-replied", { needsReply: true, threadId: "t2", receivedAt: at(4) }),
      mail("sibling", { threadId: "t2", receivedAt: at(1) }),
      mail("sent-folder", { needsReply: true, threadId: "t3", receivedAt: at(2) }),
      mail("reply-before-new-mail", { needsReply: true, threadId: "t4", receivedAt: at(6) }),
    ];
    m.labels = [
      { sourceId: "sibling", providerRepliedAt: at(5) },
      { sourceId: "reply-before-new-mail", repliedAt: at(5) },
    ];
    m.sent = [{ threadId: "t3", sentAt: at(3) }];

    const input = await gatherEveningReviewInput("u1", TZ, EVENING);

    expect(input.unanswered.map((x) => x.id)).toEqual(["reply-before-new-mail"]);
    expect(m.where.sentMessage?.[0]).toMatchObject({
      userId: "u1",
      threadId: { in: ["t1", "t2", "t3", "t4"] },
    });
  });
});

describe("gatherEveningReviewInput — commitments and meetings", () => {
  it("splits commitments by owner and asks only for confident USER or COUNTERPARTY rows due in the last two days", async () => {
    m.commitments = [
      { title: "Send the deck", dueAt: new Date("2099-01-05T02:00:00Z"), owner: "USER" },
      { title: "Review the PR", dueAt: new Date("2099-01-05T12:00:00Z"), owner: "USER" },
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
    expect(m.where.commitment?.[0]).toMatchObject({
      status: "OPEN",
      owner: { in: ["USER", "COUNTERPARTY"] },
      confidence: { gte: 0.7 },
      dueAt: { gte: new Date("2099-01-02T15:00:00Z"), lt: new Date("2099-01-05T15:00:00Z") },
    });
    expect(m.where.threadBrief?.[0]).toMatchObject({
      lastMessageAt: {
        gte: new Date("2099-01-04T15:00:00Z"),
        lt: new Date("2099-01-05T15:00:00Z"),
      },
    });
  });

  it("picks tomorrow's first timed meeting: no all-day row, no zero-length row, no out-of-office block", async () => {
    m.events = [
      event("note", EARLY_TOMORROW, 0),
      event("ooo", EARLY_TOMORROW, 10 * 60),
      event("standup", LATE_TOMORROW, 30),
    ];

    const input = await gatherEveningReviewInput("u1", TZ, EVENING);

    expect(input.firstMeetingTomorrow).toEqual({
      title: "Event standup",
      startTime: LATE_TOMORROW,
    });
    expect(m.where.calendarEvent?.[0]).toMatchObject({
      allDay: false,
      startTime: { gte: new Date("2099-01-05T15:00:00Z"), lt: new Date("2099-01-06T15:00:00Z") },
    });
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
    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("sends once there is a needs-reply mail, in the user's language, with the short push body", async () => {
    m.notificationLanguage = "ko";
    m.mails = [mail("a", { needsReply: true })];

    await runProactiveActions("u1");

    expect(reviews()).toHaveLength(1);
    expect(reviews()[0]?.data).toMatchObject({ title: "오늘 아직 남은 일 1건", link: "/briefing" });
    expect(String(reviews()[0]?.data.message)).toContain("오늘 메일 중 아직 열린 것 (1)");
    const push = vi
      .mocked(sendPushNotification)
      .mock.calls.find(([, payload]) => payload.title === "오늘 아직 남은 일 1건");
    expect(push?.[1]).toMatchObject({
      title: "오늘 아직 남은 일 1건",
      body: "Sender a — Subject a",
    });
    expect(push?.[2]).toBe("daily_briefing");
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
