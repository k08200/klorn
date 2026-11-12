// Zombie web-push subscriptions: the push service keeps accepting pushes but
// the service worker on the device never confirms one. After enough of them
// over long enough, the subscription is flagged as needing re-subscribe (and,
// with PUSH_ZOMBIE_EVICTION on, sends to it stop). A receipt clears the flag.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logFindFirst: vi.fn(),
  logAggregate: vi.fn(),
  subUpdateMany: vi.fn(async () => ({ count: 1 })),
}));

vi.mock("../db.js", () => ({
  prisma: {
    pushDeliveryLog: { findFirst: mocks.logFindFirst, aggregate: mocks.logAggregate },
    pushSubscription: { updateMany: mocks.subUpdateMany },
  },
}));

import {
  clearZombieFlag,
  evaluateZombieSubscription,
  isZombieRun,
  RECEIPT_GRACE_MS,
  ZOMBIE_MIN_SPAN_MS,
  ZOMBIE_MIN_UNRECEIPTED_PUSHES,
} from "../notify/push-zombie.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-12T00:00:00Z");

describe("isZombieRun", () => {
  it("uses 20 unconfirmed pushes over at least 14 days", () => {
    expect(ZOMBIE_MIN_UNRECEIPTED_PUSHES).toBe(20);
    expect(ZOMBIE_MIN_SPAN_MS).toBe(14 * DAY);
  });

  it("flags 20 unconfirmed pushes whose oldest is 14 days old", () => {
    expect(
      isZombieRun({ unreceipted: 20, oldestUnreceiptedAt: new Date(NOW - 14 * DAY), now: NOW }),
    ).toBe(true);
  });

  it("does not flag 19 pushes, however old", () => {
    expect(
      isZombieRun({ unreceipted: 19, oldestUnreceiptedAt: new Date(NOW - 60 * DAY), now: NOW }),
    ).toBe(false);
  });

  it("does not flag many pushes inside 14 days (a closed laptop over a long weekend)", () => {
    expect(
      isZombieRun({ unreceipted: 200, oldestUnreceiptedAt: new Date(NOW - 13 * DAY), now: NOW }),
    ).toBe(false);
  });

  it("does not flag when nothing is unconfirmed", () => {
    expect(isZombieRun({ unreceipted: 0, oldestUnreceiptedAt: null, now: NOW })).toBe(false);
  });
});

describe("evaluateZombieSubscription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logFindFirst.mockResolvedValue({ createdAt: new Date(NOW - 30 * DAY) });
    mocks.logAggregate.mockResolvedValue({
      _count: { _all: 25 },
      _min: { createdAt: new Date(NOW - 20 * DAY) },
    });
  });

  it("counts only web rows of this subscription after its last receipt and past the grace", async () => {
    await evaluateZombieSubscription("sub-1", new Date(NOW));
    expect(mocks.logFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ subscriptionId: "sub-1", channel: "web" }),
        orderBy: { createdAt: "desc" },
      }),
    );
    const where = mocks.logAggregate.mock.calls[0][0].where;
    expect(where).toMatchObject({
      subscriptionId: "sub-1",
      channel: "web",
      status: "ACCEPTED",
      receivedAt: null,
      clickedAt: null,
    });
    expect(where.createdAt.gt).toEqual(new Date(NOW - 30 * DAY));
    expect(where.createdAt.lt).toEqual(new Date(NOW - RECEIPT_GRACE_MS));
  });

  it("counts from the beginning when the subscription never confirmed a push", async () => {
    mocks.logFindFirst.mockResolvedValue(null);
    await evaluateZombieSubscription("sub-1", new Date(NOW));
    const where = mocks.logAggregate.mock.calls[0][0].where;
    expect(where.createdAt.gt).toEqual(new Date(0));
  });

  it("flags the subscription once, keeping an earlier flag's time", async () => {
    expect(await evaluateZombieSubscription("sub-1", new Date(NOW))).toBe(true);
    expect(mocks.subUpdateMany).toHaveBeenCalledWith({
      where: { id: "sub-1", needsResubscribeAt: null },
      data: { needsResubscribeAt: new Date(NOW) },
    });
  });

  it("leaves a subscription below the threshold alone", async () => {
    mocks.logAggregate.mockResolvedValue({
      _count: { _all: 12 },
      _min: { createdAt: new Date(NOW - 20 * DAY) },
    });
    expect(await evaluateZombieSubscription("sub-1", new Date(NOW))).toBe(false);
    expect(mocks.subUpdateMany).not.toHaveBeenCalled();
  });
});

describe("clearZombieFlag", () => {
  it("clears only a set flag on that subscription", async () => {
    vi.clearAllMocks();
    await clearZombieFlag("sub-1");
    expect(mocks.subUpdateMany).toHaveBeenCalledWith({
      where: { id: "sub-1", needsResubscribeAt: { not: null } },
      data: { needsResubscribeAt: null },
    });
  });
});
