// Web push rows on the delivery lifecycle: queuedAt is stamped with the
// settled send, service worker receipts stamp each stage once (first
// observation wins), an action button stamps actioned, receipts only ever
// touch web rows, and any receipt clears the subscription's zombie flag.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  update: vi.fn(async () => ({})),
  updateMany: vi.fn(async () => ({ count: 1 })),
  findFirst: vi.fn(),
  findMany: vi.fn(async () => []),
  clearZombieFlag: vi.fn(async () => {}),
}));

vi.mock("../db.js", () => ({
  prisma: {
    pushDeliveryLog: {
      update: mocks.update,
      updateMany: mocks.updateMany,
      findFirst: mocks.findFirst,
      findMany: mocks.findMany,
    },
  },
}));
vi.mock("../notify/push-zombie.js", () => ({ clearZombieFlag: mocks.clearZombieFlag }));

import {
  getPushDeliveryStats,
  markPushAccepted,
  markPushFailed,
  recordPushReceipt,
} from "../notify/push-delivery.js";

const NOW = new Date("2026-11-12T00:00:10Z");
const QUEUED = new Date("2026-11-12T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findFirst.mockResolvedValue({ subscriptionId: "sub-1" });
});

describe("markPushAccepted / markPushFailed", () => {
  it("stamps when the send was handed to the push service", async () => {
    await markPushAccepted("d1", NOW, QUEUED);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "d1" },
      data: { status: "ACCEPTED", acceptedAt: NOW, queuedAt: QUEUED },
    });
    await markPushFailed("d2", { statusCode: 500, body: "x" }, QUEUED);
    expect(mocks.update.mock.calls[1][0].data).toMatchObject({
      status: "FAILED",
      queuedAt: QUEUED,
    });
  });
});

describe("recordPushReceipt", () => {
  it("only accepts a receipt for a web push row", async () => {
    mocks.findFirst.mockResolvedValue(null);
    expect(await recordPushReceipt("d1", "received", NOW)).toBe(false);
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: "d1", channel: "web" },
      select: { subscriptionId: true },
    });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("stamps device_received once", async () => {
    expect(await recordPushReceipt("d1", "received", NOW)).toBe(true);
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "d1", receivedAt: null },
      data: { receivedAt: NOW },
    });
  });

  it("stamps a click as opened, and device_received if its receipt never came", async () => {
    await recordPushReceipt("d1", "clicked", NOW);
    expect(mocks.updateMany.mock.calls.map((c) => c[0])).toEqual([
      { where: { id: "d1", receivedAt: null }, data: { receivedAt: NOW } },
      { where: { id: "d1", clickedAt: null }, data: { clickedAt: NOW } },
    ]);
  });

  it("stamps an action button as actioned with its name", async () => {
    await recordPushReceipt("d1", "actioned", NOW, "later");
    expect(mocks.updateMany.mock.calls[2][0]).toEqual({
      where: { id: "d1", actionedAt: null },
      data: { actionedAt: NOW, action: "later" },
    });
  });

  it("clears the subscription's zombie flag: the device just proved it works", async () => {
    await recordPushReceipt("d1", "received", NOW);
    expect(mocks.clearZombieFlag).toHaveBeenCalledWith("sub-1");
  });

  it("still records the receipt when clearing the flag fails", async () => {
    mocks.clearZombieFlag.mockRejectedValueOnce(new Error("db"));
    await expect(recordPushReceipt("d1", "received", NOW)).resolves.toBe(true);
  });
});

describe("getPushDeliveryStats", () => {
  it("keeps the web push rates web-only and breaks every channel out by stage", async () => {
    const at = new Date("2026-11-11T12:00:00Z");
    const base = {
      subscriptionId: null,
      category: "email_urgent",
      title: "t",
      skipReason: null,
      endpointHost: null,
      errorStatusCode: null,
      queuedAt: at,
      receivedAt: null,
      clickedAt: null,
      actionedAt: null,
      action: null,
      createdAt: at,
    };
    mocks.findMany.mockResolvedValue([
      { ...base, id: "w1", channel: "web", status: "ACCEPTED", acceptedAt: at, receivedAt: at },
      { ...base, id: "w2", channel: "web", status: "ACCEPTED", acceptedAt: at },
      { ...base, id: "f1", channel: "fcm", status: "ACCEPTED", acceptedAt: at },
      {
        ...base,
        id: "m1",
        channel: "desktop_mac",
        status: "REPORTED",
        queuedAt: null,
        acceptedAt: null,
        receivedAt: at,
        clickedAt: at,
      },
    ]);
    const stats = await getPushDeliveryStats("user-1", { now: Date.parse("2026-11-12T00:00:00Z") });
    expect(stats).toMatchObject({ total: 2, accepted: 2, received: 1, receiptRate: 0.5 });
    expect(stats.channels.web).toEqual({
      total: 2,
      sent: 2,
      failed: 0,
      skipped: 0,
      deviceReceived: 1,
      opened: 0,
      actioned: 0,
    });
    expect(stats.channels.fcm).toMatchObject({ total: 1, sent: 1, deviceReceived: 0 });
    expect(stats.channels.desktop_mac).toMatchObject({
      total: 1,
      sent: 0,
      deviceReceived: 1,
      opened: 1,
    });
    expect(stats.recent.find((r) => r.id === "m1")).toMatchObject({
      channel: "desktop_mac",
      state: "opened",
    });
  });
});
