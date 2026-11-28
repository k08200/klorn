import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * NT0 (2026-11-17) — the reply-wait reminders of proactive-actions.ts:
 * unanswered (48h) and follow-up (72h). Fixes that ship ON: no raw address
 * and no internal "(auto-added)" tag in the text, a deterministic
 * most-important-first order, the follow-up read limited to mail that needs a
 * reply, localized copy, and a push body cut on a word boundary. Behind
 * NOTIFY_WAIT_DIGEST (default off): one merged "wait" reminder delivered in
 * the user-local morning window, never in quiet hours.
 */

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  mails: [] as Array<Record<string, unknown>>,
  existing: null as Row | null,
  findFirstArgs: [] as Array<Record<string, unknown>>,
  itemsFail: false,
  contacts: [] as Row[],
  items: [] as Row[],
  emailFindMany: [] as Array<Record<string, unknown>>,
  created: [] as Row[],
}));

vi.mock("../db.js", () => {
  const empty = async () => [];
  const prisma = {
    automationConfig: { findUnique: vi.fn(async () => db.config) },
    emailMessage: {
      findMany: vi.fn(async (args: Record<string, unknown>) => {
        db.emailFindMany.push(args);
        return db.mails;
      }),
      count: vi.fn(async () => 0),
    },
    notification: {
      findFirst: vi.fn(async (args: Record<string, unknown>) => {
        db.findFirstArgs.push(args);
        return db.existing;
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        db.created.push(data);
        return { id: `n${db.created.length}`, createdAt: new Date(), ...data };
      }),
    },
    contact: {
      findFirst: vi.fn(async ({ where }: { where: { email: { equals: string } } }) => {
        return db.contacts.find((c) => c.email === where.email.equals) ?? null;
      }),
    },
    attentionItem: {
      findMany: vi.fn(async () => {
        if (db.itemsFail) throw new Error("items down");
        return db.items;
      }),
    },
    calendarEvent: { findMany: vi.fn(empty) },
    task: { findMany: vi.fn(empty), count: vi.fn(async () => 0) },
  };
  return { prisma };
});
vi.mock("../notify/push.js", () => ({ sendPushNotification: vi.fn(async () => undefined) }));
vi.mock("../notify/sms.js", () => ({ sendSms: vi.fn(async () => undefined) }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../pim/calendar-read.js", () => ({ countCalendarRows: vi.fn(async () => 0) }));
vi.mock("../agentcore/evening-review.js", () => ({
  gatherEveningReviewInput: vi.fn(async () => ({})),
  eveningReviewHasContent: vi.fn(() => false),
  composeEveningReview: vi.fn(() => null),
}));

import { runProactiveActions } from "../agentcore/proactive-actions.js";
import { sendPushNotification } from "../notify/push.js";

const DAY = 24 * 60 * 60 * 1000;
// 09:10 in Seoul (UTC+9).
const MORNING = new Date("2026-11-18T00:10:00.000Z");
// 00:05 in Seoul: the first tick after local midnight.
const MIDNIGHT = new Date("2026-11-17T15:05:00.000Z");

function waiting(from: string, subject: string, ageDays = 3) {
  return {
    id: `m-${subject}`,
    from,
    subject,
    threadId: `t-${subject}`,
    receivedAt: new Date(MORNING.getTime() - ageDays * DAY - 3_600_000),
  };
}

function wherePerCall() {
  return db.emailFindMany.map((a) => a.where as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  db.config = { timezone: "Asia/Seoul", notificationLanguage: "ko" };
  db.mails = [];
  db.existing = null;
  db.findFirstArgs = [];
  db.itemsFail = false;
  db.contacts = [];
  db.items = [];
  db.emailFindMany = [];
  db.created = [];
  delete process.env.NOTIFY_WAIT_DIGEST;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.NOTIFY_WAIT_DIGEST;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
});

describe("reply-wait reminders, flag off (fixes ship on)", () => {
  it("orders both reads most-important-first and limits the follow-up to mail that needs a reply", async () => {
    vi.setSystemTime(MORNING);
    await runProactiveActions("u1");
    const reads = db.emailFindMany;
    expect(reads.length).toBe(2);
    for (const read of reads) {
      expect(read.orderBy).toEqual([
        { priority: "asc" },
        { needsReplyConfidence: "desc" },
        { receivedAt: "asc" },
        { id: "asc" },
      ]);
      expect((read.where as Row).needsReply).toBe(true);
    }
  });

  it("keeps mail with no category in the follow-up read (NOT IN drops NULL)", async () => {
    vi.setSystemTime(MORNING);
    await runProactiveActions("u1");
    const followUp = wherePerCall().find((w) => "OR" in w);
    expect(followUp?.OR).toEqual([
      { category: null },
      { category: { notIn: ["automated", "newsletter"] } },
    ]);
  });

  it("writes localized text with no raw address and no auto-added tag", async () => {
    vi.setSystemTime(MORNING);
    db.mails = [
      waiting("ceo@acme.com", "견적서 최종 확인", 4),
      waiting("Jun Park <jun@x.com>", "Deck", 4),
    ];
    db.contacts = [{ email: "ceo@acme.com", company: null, role: null, tags: "auto-added" }];
    await runProactiveActions("u1");
    expect(db.created.map((n) => n.type).sort()).toEqual(["email_followup", "followup"]);
    for (const n of db.created) {
      const text = `${n.title}\n${n.message}`;
      expect(text).not.toContain("@");
      expect(text).not.toContain("auto-added");
      expect(text).not.toMatch(/email\(s\)|reply pending/);
    }
    const unanswered = db.created.find((n) => n.type === "email_followup");
    expect(unanswered?.title).toBe("답장 대기 2건");
    expect(unanswered?.message).toBe("acme.com · 견적서 최종 확인\nJun Park · Deck");
  });

  it("still fires right after local midnight while the flag is off (unchanged timing)", async () => {
    vi.setSystemTime(MIDNIGHT);
    db.mails = [waiting("Jun Park <jun@x.com>", "Deck")];
    await runProactiveActions("u1");
    expect(db.created.length).toBe(2);
  });

  it("cuts a long push body on a word boundary, never mid-word", async () => {
    vi.setSystemTime(MORNING);
    db.config = { timezone: "Asia/Seoul", notificationLanguage: "en" };
    db.mails = Array.from({ length: 3 }, (_, i) =>
      waiting(
        `Alexandra Konstantinopoulou-Whitfield ${i} <p${i}@x.com>`,
        `Quarterly numbers review ${i} for the board deck and the investor update`,
      ),
    );
    await runProactiveActions("u1");
    const unanswered = db.created.find((n) => n.type === "email_followup");
    const message = String(unanswered?.message);
    expect(message.length).toBeGreaterThan(200);
    const call = vi
      .mocked(sendPushNotification)
      .mock.calls.find((c) => c[0] === "u1" && c[1].title === unanswered?.title);
    const body = call?.[1].body ?? "";
    expect(body.length).toBeLessThanOrEqual(200);
    expect(body.endsWith("…")).toBe(true);
    const kept = body.slice(0, -1);
    expect(message.startsWith(kept)).toBe(true);
    // The character after the kept part is not a letter: the cut fell between words.
    expect(message.charAt(kept.length)).toMatch(/[^\p{L}\p{N}]/u);
  });
});

describe("reply-wait reminders, NOTIFY_WAIT_DIGEST on", () => {
  beforeEach(() => {
    process.env.NOTIFY_WAIT_DIGEST = "on";
  });

  it("sends nothing on the first tick after local midnight", async () => {
    vi.setSystemTime(MIDNIGHT);
    db.mails = [waiting("Jun Park <jun@x.com>", "Deck")];
    await runProactiveActions("u1");
    expect(db.created).toEqual([]);
    expect(db.emailFindMany).toEqual([]);
  });

  it("sends ONE merged wait reminder in the morning window, none from the follow-up check", async () => {
    vi.setSystemTime(MORNING);
    db.mails = [waiting("Jun Park <jun@x.com>", "Board deck — numbers check")];
    db.items = [{ sourceId: "m-Board deck — numbers check", tierReason: "숫자 확인 요청" }];
    await runProactiveActions("u1");
    expect(db.created).toHaveLength(1);
    expect(db.created[0]).toMatchObject({
      type: "email_followup",
      title: "Jun Park",
      message: "Board deck — numbers check\n3일째 답장 대기 · 숫자 확인 요청",
    });
    // One read: the merged one (needs a reply, 48h–14d, bulk categories out).
    expect(db.emailFindMany).toHaveLength(1);
    const where = db.emailFindMany[0].where as Row;
    expect(where.needsReply).toBe(true);
    expect(where.OR).toBeDefined();
  });

  it("collapses several mails of one thread into one line", async () => {
    vi.setSystemTime(MORNING);
    const a = waiting("Jun Park <jun@x.com>", "Deck");
    db.mails = [a, { ...a, id: "m-2" }, waiting("Terry Smith <t@acme.com>", "Quote")];
    await runProactiveActions("u1");
    expect(db.created[0]).toMatchObject({
      title: "답장 대기 2건",
      message: "Jun Park · Deck\nTerry Smith · Quote",
    });
  });

  it("holds the reminder during quiet hours and sends it once they end", async () => {
    db.config = {
      timezone: "Asia/Seoul",
      notificationLanguage: "en",
      quietHoursStart: "22:00",
      quietHoursEnd: "10:00",
    };
    db.mails = [waiting("Jun Park <jun@x.com>", "Deck")];
    vi.setSystemTime(MORNING); // 09:10 local, still quiet
    await runProactiveActions("u1");
    expect(db.created).toEqual([]);
    vi.setSystemTime(new Date(MORNING.getTime() + 60 * 60 * 1000)); // 10:10 local
    await runProactiveActions("u1");
    expect(db.created).toHaveLength(1);
  });

  it("skips after the morning window closes", async () => {
    vi.setSystemTime(new Date("2026-11-18T03:30:00.000Z")); // 12:30 local
    db.mails = [waiting("Jun Park <jun@x.com>", "Deck")];
    await runProactiveActions("u1");
    expect(db.created).toEqual([]);
  });

  it("dedupes against either reminder type already sent today", async () => {
    vi.setSystemTime(MORNING);
    db.mails = [waiting("Jun Park <jun@x.com>", "Deck")];
    db.existing = { id: "n0", type: "followup" };
    await runProactiveActions("u1");
    expect(db.created).toEqual([]);
  });

  it("dedupes on both reminder types since the start of the user's local day", async () => {
    vi.setSystemTime(MORNING);
    db.mails = [waiting("Jun Park <jun@x.com>", "Deck")];
    await runProactiveActions("u1");
    const where = db.findFirstArgs
      .map((a) => a.where as Row)
      .find((w) => JSON.stringify(w.type).includes("followup"));
    expect(where).toMatchObject({
      userId: "u1",
      type: { in: ["email_followup", "followup"] },
      // 2026-11-18 00:00 in Seoul.
      createdAt: { gte: new Date("2026-11-17T15:00:00.000Z") },
    });
  });

  it("reads mail 48 hours to 14 days old", async () => {
    vi.setSystemTime(MORNING);
    await runProactiveActions("u1");
    const where = db.emailFindMany[0].where as { receivedAt: { lte: Date; gte: Date } };
    expect(where.receivedAt.lte).toEqual(new Date(MORNING.getTime() - 48 * 60 * 60 * 1000));
    expect(where.receivedAt.gte).toEqual(new Date(MORNING.getTime() - 14 * DAY));
  });

  it("opens at 09:00 and closes at 12:00 local", async () => {
    db.mails = [waiting("Jun Park <jun@x.com>", "Deck")];
    const seoul = (hhmm: string) => new Date(`2026-11-18T${hhmm}:00.000+09:00`);
    const sentAt = async (hhmm: string) => {
      db.created = [];
      vi.setSystemTime(seoul(hhmm));
      await runProactiveActions("u1");
      return db.created.length;
    };
    expect(await sentAt("08:59")).toBe(0);
    expect(await sentAt("09:00")).toBe(1);
    expect(await sentAt("11:59")).toBe(1);
    expect(await sentAt("12:00")).toBe(0);
  });

  it("quiet hours that cover the morning delay the reminder instead of dropping it", async () => {
    db.config = {
      timezone: "Asia/Seoul",
      notificationLanguage: "en",
      quietHoursStart: "22:00",
      quietHoursEnd: "12:30",
    };
    db.mails = [waiting("Jun Park <jun@x.com>", "Deck")];
    vi.setSystemTime(new Date("2026-11-18T12:10:00.000+09:00"));
    await runProactiveActions("u1");
    expect(db.created).toEqual([]);
    vi.setSystemTime(new Date("2026-11-18T12:40:00.000+09:00"));
    await runProactiveActions("u1");
    expect(db.created).toHaveLength(1);
    db.created = [];
    vi.setSystemTime(new Date("2026-11-18T15:40:00.000+09:00"));
    await runProactiveActions("u1");
    expect(db.created).toEqual([]);
  });

  it("counts every waiting thread in the title, not just the listed lines", async () => {
    vi.setSystemTime(MORNING);
    db.mails = Array.from({ length: 25 }, (_, i) => waiting(`P${i} <p${i}@x.com>`, `S${i}`));
    await runProactiveActions("u1");
    expect(db.created[0]).toMatchObject({ title: "답장 대기 25건" });
    expect(String(db.created[0].message).split("\n")).toHaveLength(3);
  });

  it("sends the single reminder without its reason when the reason read fails", async () => {
    vi.setSystemTime(MORNING);
    db.config = { timezone: "Asia/Seoul", notificationLanguage: "en" };
    db.mails = [waiting("Jun Park <jun@x.com>", "Deck")];
    db.itemsFail = true;
    await runProactiveActions("u1");
    expect(db.created[0]).toMatchObject({
      title: "Jun Park",
      message: "Deck\nWaiting 3 days for your reply",
    });
  });

  it("cohort: only listed users get the new behavior", async () => {
    process.env.NOTIFY_WAIT_DIGEST = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "u-in";
    vi.setSystemTime(MIDNIGHT);
    db.mails = [waiting("Jun Park <jun@x.com>", "Deck")];
    await runProactiveActions("u-in");
    expect(db.created).toEqual([]);
    await runProactiveActions("u-out");
    expect(db.created.length).toBe(2);
  });
});
