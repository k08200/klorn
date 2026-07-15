import { beforeEach, describe, expect, it, vi } from "vitest";

type NoteRow = {
  id: string;
  userId: string;
  title: string;
  content: string;
  createdAt: Date;
};

type NotificationRow = {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  createdAt: Date;
};

type PushLogRow = {
  id: string;
  userId: string;
  notificationId: string | null;
  category: string;
  status: string;
  skipReason: string | null;
  acceptedAt: Date | null;
  receivedAt: Date | null;
  clickedAt: Date | null;
  errorStatusCode: number | null;
  createdAt: Date;
};

type AutomationConfigRow = {
  userId: string;
  dailyBriefing: boolean;
  briefingTime: string;
};

const store = vi.hoisted(() => ({
  notes: [] as NoteRow[],
  notifications: [] as NotificationRow[],
  pushLogs: [] as PushLogRow[],
  pushSubscriptionCount: 0,
  config: null as AutomationConfigRow | null,
}));

vi.mock("../db.js", () => ({
  prisma: {
    note: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string; createdAt: Range } }) =>
        newest(
          store.notes.filter(
            (row) =>
              row.userId === where.userId &&
              row.title.startsWith("Daily Briefing") &&
              inRange(row.createdAt, where.createdAt),
          ),
        ),
      ),
    },
    notification: {
      findFirst: vi.fn(
        async ({ where }: { where: { userId: string; type: string; createdAt: Range } }) =>
          newest(
            store.notifications.filter(
              (row) =>
                row.userId === where.userId &&
                row.type === where.type &&
                inRange(row.createdAt, where.createdAt),
            ),
          ),
      ),
    },
    pushSubscription: {
      count: vi.fn(async () => store.pushSubscriptionCount),
    },
    automationConfig: {
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) =>
        store.config?.userId === where.userId ? store.config : null,
      ),
    },
    pushDeliveryLog: {
      findMany: vi.fn(
        async ({
          where,
          take,
        }: {
          where: { userId: string; category: string; createdAt: Range };
          take: number;
        }) =>
          store.pushLogs
            .filter(
              (row) =>
                row.userId === where.userId &&
                row.category === where.category &&
                inRange(row.createdAt, where.createdAt),
            )
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, take),
      ),
    },
  },
}));

import { getBriefingStatus } from "../pim/briefing-status.js";

type Range = { gte: Date; lt: Date };

const NOW = new Date("2026-04-28T12:00:00.000Z");
const USER_ID = "user-1";

function resetStore() {
  store.notes.length = 0;
  store.notifications.length = 0;
  store.pushLogs.length = 0;
  store.pushSubscriptionCount = 0;
  store.config = { userId: USER_ID, dailyBriefing: true, briefingTime: "09:00" };
}

function newest<T extends { createdAt: Date }>(rows: T[]): T | null {
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
}

function inRange(value: Date, range: Range): boolean {
  return value.getTime() >= range.gte.getTime() && value.getTime() < range.lt.getTime();
}

function addBriefing() {
  store.notes.push({
    id: "note-1",
    userId: USER_ID,
    title: "Daily Briefing — 2026. 4. 28.",
    content: "**오늘은 미팅 1건, 답장 2개가 있어요.**\n\n나머지 내용",
    createdAt: new Date("2026-04-28T09:00:00.000Z"),
  });
}

function addNotification() {
  store.notifications.push({
    id: "notif-1",
    userId: USER_ID,
    type: "briefing",
    title: "Daily Briefing Ready",
    message: "오늘은 미팅 1건...",
    createdAt: new Date("2026-04-28T09:01:00.000Z"),
  });
}

function addPushLog(over: Partial<PushLogRow>) {
  store.pushLogs.push({
    id: "push-1",
    userId: USER_ID,
    notificationId: "notif-1",
    category: "daily_briefing",
    status: "ACCEPTED",
    skipReason: null,
    acceptedAt: new Date("2026-04-28T09:01:01.000Z"),
    receivedAt: null,
    clickedAt: null,
    errorStatusCode: null,
    createdAt: new Date("2026-04-28T09:01:00.000Z"),
    ...over,
  });
}

describe("getBriefingStatus", () => {
  beforeEach(resetStore);

  it("returns missing status when today's briefing does not exist", async () => {
    const status = await getBriefingStatus(USER_ID, { now: NOW });

    expect(status).toMatchObject({
      generated: false,
      note: null,
      push: { state: "no_subscription", reason: "no_subscriptions" },
      automation: { configured: true, enabled: true, briefingTime: "09:00" },
    });
  });

  it("returns today's briefing preview with markdown removed", async () => {
    addBriefing();

    const status = await getBriefingStatus(USER_ID, { now: NOW });

    expect(status.generated).toBe(true);
    expect(status.note?.preview).toBe("오늘은 미팅 1건, 답장 2개가 있어요.");
  });

  it("reports received push when the service worker receipt arrived", async () => {
    addBriefing();
    addNotification();
    addPushLog({ receivedAt: new Date("2026-04-28T09:01:05.000Z") });

    const status = await getBriefingStatus(USER_ID, { now: NOW });

    expect(status.push).toMatchObject({
      state: "received",
      deliveryId: "push-1",
      receivedAt: "2026-04-28T09:01:05.000Z",
    });
  });

  it("reports skipped push reasons", async () => {
    addBriefing();
    addNotification();
    addPushLog({
      status: "SKIPPED",
      skipReason: "rate_limited:10min cap 3/3",
      acceptedAt: null,
    });

    const status = await getBriefingStatus(USER_ID, { now: NOW });

    expect(status.push).toMatchObject({
      state: "skipped",
      reason: "rate_limited:10min cap 3/3",
    });
  });

  it("reports missing subscription when the briefing push was skipped for no devices", async () => {
    addBriefing();
    addNotification();
    addPushLog({ status: "SKIPPED", skipReason: "no_subscriptions", acceptedAt: null });

    const status = await getBriefingStatus(USER_ID, { now: NOW });

    expect(status.push).toMatchObject({ state: "no_subscription", reason: "no_subscriptions" });
  });

  it("reports disabled automation", async () => {
    store.config = { userId: USER_ID, dailyBriefing: false, briefingTime: "09:00" };

    const status = await getBriefingStatus(USER_ID, { now: NOW });

    expect(status.automation).toMatchObject({
      configured: true,
      enabled: false,
      reason: "disabled",
    });
  });

  it("reports missing automation config", async () => {
    store.config = null;

    const status = await getBriefingStatus(USER_ID, { now: NOW });

    expect(status.automation).toMatchObject({
      configured: false,
      enabled: false,
      briefingTime: null,
      reason: "no_config",
    });
  });
});
