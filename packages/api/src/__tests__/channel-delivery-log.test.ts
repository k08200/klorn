// Delivery rows for the channels other than web push: FCM / APNs / Telegram
// sends (observed up to "sent": none of them report a device receipt), desktop
// banner receipts (observed from "device_received": there is no server send to
// see), and the owner-scoped status read behind "Send test".
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(async () => ({ id: "row-1" })),
  createMany: vi.fn(async () => ({ count: 1 })),
  updateMany: vi.fn(async () => ({ count: 1 })),
  logFindFirst: vi.fn(),
  notificationFindFirst: vi.fn(),
  attentionFindFirst: vi.fn(),
  eventFindFirst: vi.fn(),
}));

vi.mock("../db.js", () => ({
  prisma: {
    pushDeliveryLog: {
      create: mocks.create,
      createMany: mocks.createMany,
      updateMany: mocks.updateMany,
      findFirst: mocks.logFindFirst,
    },
    notification: { findFirst: mocks.notificationFindFirst },
    attentionItem: { findFirst: mocks.attentionFindFirst },
    calendarEvent: { findFirst: mocks.eventFindFirst },
  },
}));

import {
  getDeliveryStatus,
  nativeSendOutcome,
  recordChannelSend,
  recordDesktopReceipt,
} from "../notify/channel-delivery-log.js";

const NOW = new Date("2026-11-12T00:00:00Z");
const QUEUED = new Date("2026-11-11T23:59:59Z");
const ID = "11111111-2222-4333-8444-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notificationFindFirst.mockResolvedValue({ id: ID });
  mocks.attentionFindFirst.mockResolvedValue({ id: ID });
  mocks.eventFindFirst.mockResolvedValue({ id: ID });
});

describe("recordChannelSend", () => {
  it("records an accepted send as sent, with the time it was handed over", async () => {
    const id = await recordChannelSend({
      userId: "user-1",
      channel: "fcm",
      notificationId: "bell-1",
      category: "email_urgent",
      title: "Klorn — Ada",
      outcome: { status: "sent" },
      queuedAt: QUEUED,
      now: NOW,
    });
    expect(id).toBe("row-1");
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        channel: "fcm",
        notificationId: "bell-1",
        category: "email_urgent",
        title: "Klorn — Ada",
        status: "ACCEPTED",
        skipReason: null,
        queuedAt: QUEUED,
        acceptedAt: NOW,
      },
      select: { id: true },
    });
  });

  it("records a failed send without an accepted time", async () => {
    await recordChannelSend({
      userId: "user-1",
      channel: "telegram",
      category: "email_urgent",
      title: "t",
      outcome: { status: "failed", reason: "telegram_error" },
      queuedAt: QUEUED,
      now: NOW,
    });
    expect(mocks.create.mock.calls[0][0].data).toMatchObject({
      channel: "telegram",
      status: "FAILED",
      skipReason: "telegram_error",
      queuedAt: QUEUED,
      acceptedAt: null,
      notificationId: null,
    });
  });

  it("never throws: a log write failure must not sink the notification path", async () => {
    mocks.create.mockRejectedValueOnce(new Error("db down"));
    await expect(
      recordChannelSend({
        userId: "user-1",
        channel: "apns",
        category: "system",
        title: "t",
        outcome: { status: "sent" },
        queuedAt: QUEUED,
      }),
    ).resolves.toBeNull();
  });
});

describe("nativeSendOutcome", () => {
  it("maps an FCM/APNs summary to sent, failed, or nothing to record", () => {
    expect(nativeSendOutcome({ status: "sent", tokens: 2, accepted: 1, failed: 1 })).toEqual({
      status: "sent",
    });
    expect(nativeSendOutcome({ status: "sent", tokens: 1, accepted: 0, failed: 1 })).toEqual({
      status: "failed",
      reason: "all_tokens_failed",
    });
    expect(
      nativeSendOutcome({
        status: "skipped",
        reason: "fcm_error",
        tokens: 0,
        accepted: 0,
        failed: 0,
      }),
    ).toEqual({ status: "failed", reason: "fcm_error" });
    expect(
      nativeSendOutcome({
        status: "skipped",
        reason: "no_device_tokens",
        tokens: 0,
        accepted: 0,
        failed: 0,
      }),
    ).toBeNull();
    expect(
      nativeSendOutcome({
        status: "skipped",
        reason: "missing_apns_credentials",
        tokens: 0,
        accepted: 0,
        failed: 0,
      }),
    ).toBeNull();
    expect(nativeSendOutcome(undefined)).toBeNull();
  });
});

describe("recordDesktopReceipt", () => {
  it("refuses a subject that is not the caller's own", async () => {
    mocks.notificationFindFirst.mockResolvedValue(null);
    const result = await recordDesktopReceipt({
      userId: "user-1",
      app: "mac",
      event: "shown",
      kind: "notification",
      id: ID,
      now: NOW,
    });
    expect(result).toBe("not_found");
    expect(mocks.notificationFindFirst).toHaveBeenCalledWith({
      where: { id: ID, userId: "user-1" },
      select: { id: true },
    });
    expect(mocks.createMany).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("checks ownership on the table the kind names", async () => {
    await recordDesktopReceipt({
      userId: "user-1",
      app: "mac",
      event: "shown",
      kind: "attention_item",
      id: ID,
      now: NOW,
    });
    expect(mocks.attentionFindFirst).toHaveBeenCalledWith({
      where: { id: ID, userId: "user-1" },
      select: { id: true },
    });
    await recordDesktopReceipt({
      userId: "user-1",
      app: "mac",
      event: "shown",
      kind: "calendar_event",
      id: ID,
      now: NOW,
    });
    // A linked calendar's event counts only while its sync is on (C2).
    expect(mocks.eventFindFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: ID, userId: "user-1", sourceAccountId: null }),
      select: { id: true },
    });
  });

  it("creates the row at most once per app and subject, with no send it did not see", async () => {
    const result = await recordDesktopReceipt({
      userId: "user-1",
      app: "windows",
      event: "shown",
      kind: "notification",
      id: ID,
      now: NOW,
    });
    expect(result).toBe("recorded");
    expect(mocks.createMany).toHaveBeenCalledWith({
      data: [
        {
          userId: "user-1",
          channel: "desktop_windows",
          dedupeKey: `desktop:user-1:windows:notification:${ID}`,
          notificationId: ID,
          category: "desktop_banner",
          title: "",
          status: "REPORTED",
        },
      ],
      skipDuplicates: true,
    });
    const created = mocks.createMany.mock.calls[0][0].data[0];
    expect(created).not.toHaveProperty("acceptedAt");
    expect(created).not.toHaveProperty("queuedAt");
  });

  it("links only a bell notification id; other subjects stay in the dedupe key", async () => {
    await recordDesktopReceipt({
      userId: "user-1",
      app: "mac",
      event: "shown",
      kind: "attention_item",
      id: ID,
      now: NOW,
    });
    expect(mocks.createMany.mock.calls[0][0].data[0]).toMatchObject({
      channel: "desktop_mac",
      dedupeKey: `desktop:user-1:mac:attention_item:${ID}`,
      notificationId: null,
    });
  });

  it("stamps shown as device_received, first observation wins", async () => {
    await recordDesktopReceipt({
      userId: "user-1",
      app: "mac",
      event: "shown",
      kind: "notification",
      id: ID,
      now: NOW,
    });
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        dedupeKey: `desktop:user-1:mac:notification:${ID}`,
        userId: "user-1",
        receivedAt: null,
      },
      data: { receivedAt: NOW },
    });
  });

  it("stamps a click as opened (a click proves the banner was shown)", async () => {
    await recordDesktopReceipt({
      userId: "user-1",
      app: "mac",
      event: "clicked",
      kind: "notification",
      id: ID,
      now: NOW,
    });
    const datas = mocks.updateMany.mock.calls.map((c) => c[0].data);
    expect(datas).toEqual([{ receivedAt: NOW }, { clickedAt: NOW }]);
  });

  it("stamps an action button as actioned with the action", async () => {
    await recordDesktopReceipt({
      userId: "user-1",
      app: "mac",
      event: "actioned",
      action: "later",
      kind: "notification",
      id: ID,
      now: NOW,
    });
    const calls = mocks.updateMany.mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.data)).toEqual([
      { receivedAt: NOW },
      { clickedAt: NOW },
      { actionedAt: NOW, action: "later" },
    ]);
    expect(calls[2].where).toMatchObject({ actionedAt: null });
  });
});

describe("getDeliveryStatus", () => {
  it("reads only the caller's own row and reports its lifecycle state", async () => {
    mocks.logFindFirst.mockResolvedValue({
      id: "row-1",
      channel: "web",
      status: "ACCEPTED",
      createdAt: QUEUED,
      queuedAt: QUEUED,
      acceptedAt: QUEUED,
      receivedAt: NOW,
      clickedAt: null,
      actionedAt: null,
    });
    const status = await getDeliveryStatus("user-1", "row-1");
    expect(mocks.logFindFirst.mock.calls[0][0].where).toEqual({ id: "row-1", userId: "user-1" });
    expect(status).toEqual({
      id: "row-1",
      channel: "web",
      status: "ACCEPTED",
      state: "device_received",
      createdAt: QUEUED.toISOString(),
      queuedAt: QUEUED.toISOString(),
      sentAt: QUEUED.toISOString(),
      receivedAt: NOW.toISOString(),
      openedAt: null,
      actionedAt: null,
    });
  });

  it("is null for a row that is missing or someone else's", async () => {
    mocks.logFindFirst.mockResolvedValue(null);
    expect(await getDeliveryStatus("user-1", "row-x")).toBeNull();
  });
});
