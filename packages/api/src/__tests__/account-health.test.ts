/**
 * Account Health (Settings -> Accounts): one list of every connected mail
 * account, with provider, status, last sync and the action needed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindUnique = vi.hoisted(() => vi.fn());
const tokenFindFirst = vi.hoisted(() => vi.fn());
const linkedFindMany = vi.hoisted(() => vi.fn());
vi.mock("../db.js", () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    userToken: { findFirst: tokenFindFirst },
    linkedInboxAccount: { findMany: linkedFindMany },
  },
  db: {},
}));

const { accountHealthStatus, listAccountHealth } = await import("../mail/account-health.js");

const T = new Date("2026-11-12T10:00:00Z");

describe("accountHealthStatus", () => {
  it("asks for a reconnect when credentials were refused, whatever else is recorded", () => {
    expect(
      accountHealthStatus({
        needsReconnect: true,
        errorCode: "auth",
        lastSyncedAt: T,
        polled: true,
      }),
    ).toEqual({ status: "reconnect", action: "reconnect" });
  });

  it("is an error (Klorn keeps trying, nothing to do) for any other recorded failure", () => {
    expect(
      accountHealthStatus({
        needsReconnect: false,
        errorCode: "unreachable",
        lastSyncedAt: T,
        polled: true,
      }),
    ).toEqual({ status: "error", action: null });
  });

  it("is pending until a polled account first syncs, ok after", () => {
    const base = { needsReconnect: false, errorCode: null, polled: true };
    expect(accountHealthStatus({ ...base, lastSyncedAt: null }).status).toBe("pending");
    expect(accountHealthStatus({ ...base, lastSyncedAt: T }).status).toBe("ok");
    expect(accountHealthStatus({ ...base, lastSyncedAt: null, polled: false }).status).toBe("ok");
  });
});

describe("listAccountHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFindUnique.mockResolvedValue({ email: "me@gmail.com" });
    tokenFindFirst.mockResolvedValue({ refreshToken: "rt", lastSyncedAt: T });
    linkedFindMany.mockResolvedValue([
      {
        id: "acc-icloud",
        email: "me@icloud.com",
        provider: "ICLOUD",
        needsReconnect: true,
        lastSyncedAt: T,
        syncErrorCode: "auth",
        syncErrorAt: T,
      },
      {
        id: "acc-outlook",
        email: "me@outlook.com",
        provider: "OUTLOOK",
        needsReconnect: false,
        lastSyncedAt: null,
        syncErrorCode: "something-new",
        syncErrorAt: T,
      },
      {
        id: "acc-klorn",
        email: "me@klorn.ai",
        provider: "KLORN",
        needsReconnect: false,
        lastSyncedAt: null,
        syncErrorCode: null,
        syncErrorAt: null,
      },
    ]);
  });

  it("lists the primary inbox and every linked account, scoped to the caller", async () => {
    const { accounts } = await listAccountHealth("u1");

    expect(tokenFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u1", provider: "google" } }),
    );
    expect(linkedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u1" } }),
    );
    // No secret leaves the database: only status columns are selected.
    const select = linkedFindMany.mock.calls[0]?.[0]?.select ?? {};
    expect(Object.keys(select)).not.toEqual(expect.arrayContaining(["imapPasswordCipher"]));
    expect(select).not.toHaveProperty("accessToken");

    expect(accounts).toEqual([
      {
        id: null,
        email: "me@gmail.com",
        provider: "GOOGLE",
        kind: "primary",
        status: "ok",
        action: null,
        lastSyncedAt: T.toISOString(),
        errorCode: null,
        errorAt: null,
      },
      {
        id: "acc-icloud",
        email: "me@icloud.com",
        provider: "ICLOUD",
        kind: "linked",
        status: "reconnect",
        action: "reconnect",
        lastSyncedAt: T.toISOString(),
        errorCode: "auth",
        errorAt: T.toISOString(),
      },
      {
        // An unknown stored code reads as none: never a crash, never raw text.
        id: "acc-outlook",
        email: "me@outlook.com",
        provider: "OUTLOOK",
        kind: "linked",
        status: "pending",
        action: null,
        lastSyncedAt: null,
        errorCode: null,
        errorAt: null,
      },
      {
        id: "acc-klorn",
        email: "me@klorn.ai",
        provider: "KLORN",
        kind: "linked",
        status: "ok",
        action: null,
        lastSyncedAt: null,
        errorCode: null,
        errorAt: null,
      },
    ]);
  });

  it("says reconnect for a primary grant that lost its refresh token, and omits a missing one", async () => {
    tokenFindFirst.mockResolvedValueOnce({ refreshToken: null, lastSyncedAt: null });
    linkedFindMany.mockResolvedValueOnce([]);
    expect((await listAccountHealth("u1")).accounts[0]).toMatchObject({
      kind: "primary",
      status: "reconnect",
      action: "reconnect",
    });

    tokenFindFirst.mockResolvedValueOnce(null);
    linkedFindMany.mockResolvedValueOnce([]);
    expect((await listAccountHealth("u1")).accounts).toEqual([]);
  });
});
