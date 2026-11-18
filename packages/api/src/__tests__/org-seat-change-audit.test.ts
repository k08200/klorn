/**
 * A seat change's audit rows (org/seat-change-audit.ts): the request row is
 * committed before the Paddle call and taken back only when Paddle refuses;
 * an unanswered call adds an "unconfirmed" row with the failure as a code
 * (never provider text). Failed bookkeeping after the call is reported with
 * facts only and never replaces the answer the owner gets. The Postgres proof
 * through the route is org-seat-management-pg.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  orgAuditEvent: { create: vi.fn(), deleteMany: vi.fn() },
}));
const captureError = vi.hoisted(() => vi.fn());
vi.mock("../db.js", () => ({ prisma: db, db }));
vi.mock("../sentry.js", () => ({ captureError }));

import { PaddleApiError } from "../billing/paddle.js";
import {
  assertNoSeatChangeSince,
  paddleRefused,
  recordSeatChangeRequest,
  recordSeatChangeUnconfirmed,
  SEAT_CHANGE_DOUBT_MS,
  SEAT_CHANGE_IN_FLIGHT_MS,
  type SeatChangeAttempt,
  withdrawSeatChangeRequest,
} from "../org/seat-change-audit.js";

const ATTEMPT: SeatChangeAttempt = {
  orgId: "org-1",
  actorUserId: "u-owner",
  from: 3,
  to: 5,
  payer: "email",
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("seat change audit rows", () => {
  it("commits the request with counts and the payer basis, and hands back its id", async () => {
    db.orgAuditEvent.create.mockResolvedValue({ id: "row-1" });
    expect(await recordSeatChangeRequest(ATTEMPT)).toBe("row-1");
    expect(await recordSeatChangeRequest({ ...ATTEMPT, payer: null })).toBe("row-1");
    expect(db.orgAuditEvent.create.mock.calls.map(([args]) => args)).toEqual([
      {
        data: {
          orgId: "org-1",
          action: "billing.seats_change_requested",
          actorUserId: "u-owner",
          detail: { from: 3, to: 5, payer: "email" },
        },
        select: { id: true },
      },
      {
        data: {
          orgId: "org-1",
          action: "billing.seats_change_requested",
          actorUserId: "u-owner",
          detail: { from: 3, to: 5 },
        },
        select: { id: true },
      },
    ]);
  });

  it("lets a failed request write stop the change (the Paddle call never runs)", async () => {
    db.orgAuditEvent.create.mockRejectedValue(new Error("db down"));
    await expect(recordSeatChangeRequest(ATTEMPT)).rejects.toThrow("db down");
  });

  it("records an unconfirmed change by failure code only", async () => {
    await recordSeatChangeUnconfirmed(ATTEMPT, "PROVIDER_UNAVAILABLE");
    expect(db.orgAuditEvent.create).toHaveBeenCalledWith({
      data: {
        orgId: "org-1",
        action: "billing.seats_change_unconfirmed",
        actorUserId: "u-owner",
        detail: { from: 3, to: 5, failure: "PROVIDER_UNAVAILABLE" },
      },
    });
  });

  it("tries a failed unconfirmed write once more before giving up", async () => {
    db.orgAuditEvent.create.mockRejectedValueOnce(new Error("db blip")).mockResolvedValue({});
    await recordSeatChangeUnconfirmed(ATTEMPT, "PROVIDER_UNAVAILABLE");
    expect(db.orgAuditEvent.create).toHaveBeenCalledTimes(2);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("reports a failed unconfirmed write with the row's facts and does not throw", async () => {
    db.orgAuditEvent.create.mockRejectedValue(new Error("db down"));
    await expect(
      recordSeatChangeUnconfirmed(ATTEMPT, "PROVIDER_UNAVAILABLE"),
    ).resolves.toBeUndefined();
    expect(db.orgAuditEvent.create).toHaveBeenCalledTimes(2);
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { scope: "org.billing.audit_seat_change" },
        extra: expect.objectContaining({
          orgId: "org-1",
          seatsFrom: 3,
          seatsTo: 5,
          failure: "PROVIDER_UNAVAILABLE",
        }),
      }),
    );
  });

  it("takes back only that organization's request row, and reports a failed withdrawal", async () => {
    await withdrawSeatChangeRequest("row-1", "org-1");
    expect(db.orgAuditEvent.deleteMany).toHaveBeenCalledWith({
      where: { id: "row-1", orgId: "org-1", action: "billing.seats_change_requested" },
    });
    db.orgAuditEvent.deleteMany.mockRejectedValue(new Error("db down"));
    await expect(withdrawSeatChangeRequest("row-1", "org-1")).resolves.toBeUndefined();
    expect(captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { scope: "org.billing.audit_seat_change" },
        extra: expect.objectContaining({ orgId: "org-1", auditEventId: "row-1" }),
      }),
    );
  });

  it("tells a Paddle refusal (it answered 4xx) from a call that may have reached it", () => {
    expect(paddleRefused(new PaddleApiError(400, "bad_request", "x"))).toBe(true);
    expect(paddleRefused(new PaddleApiError(409, null, "x"))).toBe(true);
    expect(paddleRefused(new PaddleApiError(408, null, "x"))).toBe(false);
    expect(paddleRefused(new PaddleApiError(500, null, "x"))).toBe(false);
    expect(paddleRefused(new PaddleApiError(503, null, "x"))).toBe(false);
    expect(paddleRefused(new DOMException("aborted", "TimeoutError"))).toBe(false);
    expect(paddleRefused(new TypeError("fetch failed"))).toBe(false);
  });
});

describe("a stale live read: changed since, or still settling", () => {
  const NOW = new Date("2026-11-18T12:00:00Z");
  const READ = {
    mark: { id: "ev-1", createdAt: new Date("2026-11-18T11:00:00Z") },
    startedAt: NOW,
  };

  /** A locked transaction whose two audit reads answer `changed` then `settling`. */
  function txAnswering(changed: object | null, settling: object | null) {
    const findFirst = vi.fn().mockResolvedValueOnce(changed).mockResolvedValueOnce(settling);
    return { tx: { orgAuditEvent: { findFirst } } as never, findFirst };
  }

  async function refusal(tx: never) {
    try {
      await assertNoSeatChangeSince(tx, "org-1", READ, NOW);
      return null;
    } catch (err) {
      return err as { statusCode: number; code: string };
    }
  }

  it("answers SEATS_CHANGED for a change since the mark, without asking whether one is settling", async () => {
    const { tx, findFirst } = txAnswering({ id: "ev-2" }, { id: "ev-3" });
    expect(await refusal(tx)).toMatchObject({ statusCode: 409, code: "SEATS_CHANGED" });
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { orgId: "org-1", action: "billing.seats_change_requested" },
    });
  });

  it("answers SEATS_CHANGE_IN_FLIGHT when nothing changed since but an earlier change may still move the count", async () => {
    const { tx, findFirst } = txAnswering(null, { id: "ev-1" });
    expect(await refusal(tx)).toMatchObject({ statusCode: 409, code: "SEATS_CHANGE_IN_FLIGHT" });
    expect(findFirst.mock.calls[1]?.[0]).toEqual({
      where: {
        orgId: "org-1",
        OR: [
          {
            action: "billing.seats_change_requested",
            createdAt: { gt: new Date(NOW.getTime() - SEAT_CHANGE_IN_FLIGHT_MS) },
          },
          {
            action: "billing.seats_change_unconfirmed",
            createdAt: { gt: new Date(NOW.getTime() - SEAT_CHANGE_DOUBT_MS) },
          },
        ],
      },
      select: { id: true },
    });
  });

  it("lets the change through when neither holds", async () => {
    const { tx } = txAnswering(null, null);
    expect(await refusal(tx)).toBeNull();
  });
});
