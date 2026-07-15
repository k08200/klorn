import { beforeEach, describe, expect, it, vi } from "vitest";

type LogRow = {
  id: string;
  userId: string;
  subscriptionId: string | null;
  notificationId: string | null;
  endpointHost: string | null;
  category: string;
  title: string;
  status: string;
  skipReason: string | null;
  errorStatusCode: number | null;
  errorBody: string | null;
  acceptedAt: Date | null;
  receivedAt: Date | null;
  clickedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const store = vi.hoisted(() => ({
  logs: [] as LogRow[],
  nextId: 1,
}));

vi.mock("../db.js", () => ({
  prisma: {
    pushDeliveryLog: {
      create: vi.fn(async ({ data, select }: { data: Partial<LogRow>; select?: { id: true } }) => {
        const row: LogRow = {
          id: `pdl-${store.nextId++}`,
          userId: data.userId ?? "user-1",
          subscriptionId: data.subscriptionId ?? null,
          notificationId: data.notificationId ?? null,
          endpointHost: data.endpointHost ?? null,
          category: data.category ?? "system",
          title: data.title ?? "Untitled",
          status: data.status ?? "PENDING",
          skipReason: data.skipReason ?? null,
          errorStatusCode: data.errorStatusCode ?? null,
          errorBody: data.errorBody ?? null,
          acceptedAt: data.acceptedAt ?? null,
          receivedAt: data.receivedAt ?? null,
          clickedAt: data.clickedAt ?? null,
          createdAt: data.createdAt ?? new Date("2026-04-28T00:00:00.000Z"),
          updatedAt: data.updatedAt ?? new Date("2026-04-28T00:00:00.000Z"),
        };
        store.logs.push(row);
        return select?.id ? { id: row.id } : row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<LogRow> }) => {
        const row = store.logs.find((log) => log.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; receivedAt?: null };
          data: Partial<LogRow>;
        }) => {
          const row = store.logs.find((log) => log.id === where.id);
          if (!row) return { count: 0 };
          if (where.receivedAt === null && row.receivedAt !== null) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
      findMany: vi.fn(
        async ({
          where,
          take,
        }: {
          where: { userId: string; createdAt: { gte: Date } };
          take: number;
        }) =>
          store.logs
            .filter(
              (log) =>
                log.userId === where.userId &&
                log.createdAt.getTime() >= where.createdAt.gte.getTime(),
            )
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, take),
      ),
    },
  },
}));

import {
  createPushDeliveryAttempt,
  createSkippedPushDelivery,
  getPushDeliveryStats,
  markPushAccepted,
  markPushFailed,
  recordPushReceipt,
} from "../notify/push-delivery.js";

describe("push delivery observability", () => {
  beforeEach(() => {
    store.logs.length = 0;
    store.nextId = 1;
  });

  it("records an attempt with endpoint host and marks accepted", async () => {
    const id = await createPushDeliveryAttempt({
      userId: "user-1",
      subscriptionId: "sub-1",
      endpoint: "https://webpush.push.apple.com/abc",
      category: "briefing",
      title: "Morning briefing",
    });

    await markPushAccepted(id, new Date("2026-04-28T00:01:00.000Z"));

    expect(store.logs[0]).toMatchObject({
      id,
      endpointHost: "webpush.push.apple.com",
      status: "ACCEPTED",
      acceptedAt: new Date("2026-04-28T00:01:00.000Z"),
    });
  });

  it("records service worker receipts and clicks", async () => {
    const id = await createPushDeliveryAttempt({
      userId: "user-1",
      category: "system",
      title: "Test",
    });

    expect(await recordPushReceipt(id, "received", new Date("2026-04-28T00:02:00.000Z"))).toBe(
      true,
    );
    expect(await recordPushReceipt(id, "clicked", new Date("2026-04-28T00:03:00.000Z"))).toBe(true);

    expect(store.logs[0].receivedAt).toEqual(new Date("2026-04-28T00:02:00.000Z"));
    expect(store.logs[0].clickedAt).toEqual(new Date("2026-04-28T00:03:00.000Z"));
  });

  it("summarizes accepted, failed, skipped, and received pushes", async () => {
    const accepted = await createPushDeliveryAttempt({
      userId: "user-1",
      category: "briefing",
      title: "Briefing",
    });
    await markPushAccepted(accepted);
    await recordPushReceipt(accepted, "received");

    const failed = await createPushDeliveryAttempt({
      userId: "user-1",
      category: "email_urgent",
      title: "Urgent",
    });
    await markPushFailed(failed, { statusCode: 410, body: "gone" });

    await createSkippedPushDelivery({
      userId: "user-1",
      category: "system",
      title: "Skipped",
      skipReason: "no_subscriptions",
    });

    const stats = await getPushDeliveryStats("user-1", {
      now: Date.parse("2026-04-28T01:00:00.000Z"),
    });

    expect(stats).toMatchObject({
      total: 3,
      accepted: 1,
      failed: 1,
      skipped: 1,
      received: 1,
      receiptRate: 1,
    });
  });
});
