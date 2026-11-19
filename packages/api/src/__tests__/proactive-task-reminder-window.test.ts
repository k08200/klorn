import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The overdue-task and deadline (D-3) reminders of agentcore/proactive-actions.ts
 * fired on the first tick of the user's local day, i.e. just after local
 * midnight — the pattern #1803 fixed for the reply-wait reminder. Under
 * NOTIFY_WAIT_DIGEST they now use the same delivery window
 * (notify/morning-window.ts): user-local 09:00–12:00, never inside quiet hours,
 * and delayed — not dropped — when quiet hours end after 09:00. Flag off they
 * keep their old timing (pinned below).
 */

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  config: { timezone: "Asia/Seoul" } as Row | null,
  overdue: [] as Row[],
  approaching: [] as Row[],
  created: [] as Row[],
}));

vi.mock("../db.js", () => {
  const empty = async () => [];
  const prisma = {
    automationConfig: { findUnique: vi.fn(async () => db.config) },
    userToken: { findFirst: vi.fn(async () => null) },
    calendarEvent: { findMany: vi.fn(empty) },
    emailMessage: { findMany: vi.fn(empty), count: vi.fn(async () => 0) },
    notification: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { type?: string | { in: string[] }; createdAt?: { gte: Date } };
        }) =>
          db.created.find(
            (n) =>
              (typeof where.type === "string" ? n.type === where.type : true) &&
              (!where.createdAt || (n.createdAt as Date) >= where.createdAt.gte),
          ) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `n${db.created.length + 1}`, createdAt: new Date(), ...data };
        db.created.push(row);
        return row;
      }),
    },
    contact: { findFirst: vi.fn(async () => null) },
    attentionItem: { findMany: vi.fn(empty) },
    task: {
      findMany: vi.fn(async ({ where }: { where: { dueDate: { lt?: Date; gt?: Date } } }) =>
        where.dueDate.lt ? db.overdue : db.approaching,
      ),
      count: vi.fn(async () => 0),
    },
  };
  return { prisma };
});
vi.mock("../notify/push.js", () => ({ sendPushNotification: vi.fn(async () => undefined) }));
vi.mock("../notify/sms.js", () => ({ sendSms: vi.fn(async () => undefined) }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../pim/calendar-read.js", () => ({ countCalendarRows: vi.fn(async () => 0) }));
vi.mock("../report-db-failure.js", () => ({ logDbFailure: vi.fn(), captureDbFailure: vi.fn() }));
vi.mock("../agentcore/evening-review.js", () => ({
  gatherEveningReviewInput: vi.fn(async () => ({})),
  eveningReviewHasContent: vi.fn(() => false),
  composeEveningReview: vi.fn(() => null),
}));

import { runProactiveActions } from "../agentcore/proactive-actions.js";

/** A UTC instant at this Seoul (UTC+9) wall-clock time on 2026-11-19. */
const seoul = (hh: number, mm = 0) => new Date(Date.UTC(2026, 10, 19, hh - 9, mm));

const reminders = () =>
  db.created.filter(
    (n) => n.type === "deadline" || (n.type === "task" && /overdue/.test(String(n.title))),
  );

async function tickAt(at: Date) {
  vi.setSystemTime(at);
  await runProactiveActions("u1");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  db.config = { timezone: "Asia/Seoul" };
  db.created = [];
  db.overdue = [
    {
      id: "t1",
      title: "Send invoice",
      dueDate: new Date("2026-11-17T00:00:00Z"),
      priority: "HIGH",
    },
  ];
  db.approaching = [{ id: "t2", title: "Board deck", dueDate: new Date("2026-11-20T09:00:00Z") }];
  delete process.env.NOTIFY_WAIT_DIGEST;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.NOTIFY_WAIT_DIGEST;
});

describe("overdue and deadline reminders — flag off keeps the old timing", () => {
  it("both fire on the first tick after local midnight, as before", async () => {
    await tickAt(seoul(0, 1));
    expect(
      reminders()
        .map((n) => n.type)
        .sort(),
    ).toEqual(["deadline", "task"]);
  });
});

describe("overdue and deadline reminders — NOTIFY_WAIT_DIGEST: the morning window", () => {
  beforeEach(() => {
    process.env.NOTIFY_WAIT_DIGEST = "on";
  });

  it("nothing fires just after local midnight", async () => {
    await tickAt(seoul(0, 1));
    await tickAt(seoul(8, 59));
    expect(reminders()).toEqual([]);
  });

  it("both fire once at 09:00 local, and not again that day", async () => {
    await tickAt(seoul(0, 1));
    await tickAt(seoul(9, 0));
    await tickAt(seoul(9, 1));
    await tickAt(seoul(11, 30));
    expect(
      reminders()
        .map((n) => n.type)
        .sort(),
    ).toEqual(["deadline", "task"]);
  });

  it("past the window with no quiet hours, a day that missed it waits for tomorrow", async () => {
    await tickAt(seoul(12, 0));
    expect(reminders()).toEqual([]);
  });

  it("quiet hours that cover the morning delay the reminders until they end, not drop them", async () => {
    db.config = { timezone: "Asia/Seoul", quietHoursStart: "22:00", quietHoursEnd: "10:00" };
    await tickAt(seoul(9, 30));
    expect(reminders()).toEqual([]);
    await tickAt(seoul(10, 0));
    expect(
      reminders()
        .map((n) => n.type)
        .sort(),
    ).toEqual(["deadline", "task"]);
  });

  it("quiet hours that end after the window still deliver, late, the same day", async () => {
    db.config = { timezone: "Asia/Seoul", quietHoursStart: "22:00", quietHoursEnd: "13:00" };
    await tickAt(seoul(12, 30));
    expect(reminders()).toEqual([]);
    await tickAt(seoul(13, 5));
    expect(
      reminders()
        .map((n) => n.type)
        .sort(),
    ).toEqual(["deadline", "task"]);
  });

  it("a cohort flag reaches only the cohort: everyone else keeps the old timing", async () => {
    process.env.NOTIFY_WAIT_DIGEST = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "someone-else";
    try {
      await tickAt(seoul(0, 1));
      expect(
        reminders()
          .map((n) => n.type)
          .sort(),
      ).toEqual(["deadline", "task"]);
    } finally {
      delete process.env.ROLLOUT_COHORT_USER_IDS;
    }
  });
});
