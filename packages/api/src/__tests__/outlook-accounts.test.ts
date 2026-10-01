/**
 * Phase 3B: the OUTLOOK fan-out — token decrypt/refresh lifecycle, rotated
 * refresh-token persistence, reconnect flagging on every auth-failure path,
 * per-account isolation, and the resumable delta cursor stored in historyId.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(async () => ({ count: 1 })),
  syncOutlookInbox: vi.fn(),
  refreshOutlookTokens: vi.fn(),
  markLinkedInboxForReconnect: vi.fn(async () => undefined),
}));

vi.mock("../db.js", () => {
  const prisma = {
    linkedInboxAccount: { findMany: m.findMany, updateMany: m.updateMany },
  };
  return { prisma, db: prisma };
});
vi.mock("../crypto-tokens.js", () => ({
  decryptToken: vi.fn((cipher: string) => {
    if (cipher === "BAD") throw new Error("undecryptable");
    return `plain:${cipher}`;
  }),
  decryptOptional: vi.fn((cipher: string | null) => {
    if (cipher === "BAD") throw new Error("undecryptable");
    return cipher ? `plain:${cipher}` : null;
  }),
  encryptToken: vi.fn((t: string) => `enc:${t}`),
  encryptOptional: vi.fn((t: string | null) => (t ? `enc:${t}` : null)),
}));
vi.mock("../mail/gmail.js", () => ({
  markLinkedInboxForReconnect: m.markLinkedInboxForReconnect,
}));
vi.mock("../mail/outlook-oauth.js", () => ({
  refreshOutlookTokens: m.refreshOutlookTokens,
}));
vi.mock("../mail/outlook-sync.js", () => ({
  syncOutlookInbox: m.syncOutlookInbox,
}));

const { syncOutlookAccountsForUser } = await import("../mail/outlook-accounts.js");

const FUTURE = new Date(Date.now() + 60 * 60_000);
const PAST = new Date(Date.now() - 60_000);

function outlookRow(over: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    userId: "u1",
    provider: "OUTLOOK",
    email: "a@outlook.com",
    accessToken: "at-cipher",
    refreshToken: "rt-cipher",
    expiresAt: FUTURE,
    historyId: null,
    needsReconnect: false,
    ...over,
  };
}

function syncOk(over: Record<string, unknown> = {}) {
  return {
    fetched: 2,
    inserted: 1,
    classified: 1,
    errors: 0,
    cursor: "https://graph.microsoft.com/v1.0/me/delta?token=new",
    authFailed: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.updateMany.mockResolvedValue({ count: 1 });
  m.syncOutlookInbox.mockResolvedValue(syncOk());
  m.refreshOutlookTokens.mockResolvedValue({
    accessToken: "new-at",
    refreshToken: "new-rt",
    expiresAt: FUTURE,
  });
});

describe("syncOutlookAccountsForUser", () => {
  it("returns null when the user has no OUTLOOK rows", async () => {
    m.findMany.mockResolvedValue([]);
    expect(await syncOutlookAccountsForUser("u1")).toBeNull();
    expect(m.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "u1", provider: "OUTLOOK" }),
      }),
    );
  });

  it("syncs a fresh-token row without refreshing, passing the stored cursor", async () => {
    m.findMany.mockResolvedValue([outlookRow({ historyId: "https://graph.microsoft.com/x" })]);
    await syncOutlookAccountsForUser("u1");
    expect(m.refreshOutlookTokens).not.toHaveBeenCalled();
    expect(m.syncOutlookInbox).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        email: "a@outlook.com",
        accessToken: "plain:at-cipher",
        linkedInboxAccountId: "row-1",
        cursor: "https://graph.microsoft.com/x",
      }),
    );
  });

  it("refreshes an expired token and persists BOTH rotated ciphers", async () => {
    m.findMany.mockResolvedValue([outlookRow({ expiresAt: PAST })]);
    await syncOutlookAccountsForUser("u1");
    expect(m.refreshOutlookTokens).toHaveBeenCalledWith("plain:rt-cipher");
    expect(m.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // Compare-and-swap on the refresh cipher that was read (a concurrent refresh
        // that stored first is not overwritten); otherwise the write is unchanged.
        where: { id: "row-1", userId: "u1", refreshToken: "rt-cipher" },
        data: expect.objectContaining({
          accessToken: "enc:new-at",
          refreshToken: "enc:new-rt",
          needsReconnect: false,
        }),
      }),
    );
    expect(m.syncOutlookInbox).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "new-at" }),
    );
  });

  it("keeps the old refresh cipher when the response omits a new one", async () => {
    m.refreshOutlookTokens.mockResolvedValue({
      accessToken: "new-at",
      refreshToken: null,
      expiresAt: FUTURE,
    });
    m.findMany.mockResolvedValue([outlookRow({ expiresAt: PAST })]);
    await syncOutlookAccountsForUser("u1");
    const tokenWrite = m.updateMany.mock.calls.find((c) => c[0]?.data?.accessToken);
    expect(tokenWrite?.[0].data).not.toHaveProperty("refreshToken");
  });

  it.each([
    ["undecryptable cipher", outlookRow({ accessToken: "BAD" })],
    ["expired with no refresh token", outlookRow({ expiresAt: PAST, refreshToken: null })],
  ])("marks reconnect (provider OUTLOOK) and skips on %s", async (_name, row) => {
    m.findMany.mockResolvedValue([row]);
    const result = await syncOutlookAccountsForUser("u1");
    expect(m.markLinkedInboxForReconnect).toHaveBeenCalledWith("u1", "row-1", "OUTLOOK");
    expect(m.syncOutlookInbox).not.toHaveBeenCalled();
    expect(result?.errors).toBe(1);
  });

  it("marks reconnect when the refresh grant is rejected", async () => {
    m.refreshOutlookTokens.mockResolvedValue({ error: "invalid_grant" });
    m.findMany.mockResolvedValue([outlookRow({ expiresAt: PAST })]);
    await syncOutlookAccountsForUser("u1");
    expect(m.markLinkedInboxForReconnect).toHaveBeenCalledWith("u1", "row-1", "OUTLOOK");
    expect(m.syncOutlookInbox).not.toHaveBeenCalled();
  });

  it("marks reconnect when Graph itself 401s mid-sync", async () => {
    m.syncOutlookInbox.mockResolvedValue(syncOk({ authFailed: true, cursor: null }));
    m.findMany.mockResolvedValue([outlookRow()]);
    await syncOutlookAccountsForUser("u1");
    expect(m.markLinkedInboxForReconnect).toHaveBeenCalledWith("u1", "row-1", "OUTLOOK");
  });

  it("stamps lastSyncedAt and advances historyId only when a cursor came back", async () => {
    m.findMany.mockResolvedValue([outlookRow()]);
    await syncOutlookAccountsForUser("u1");
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { id: "row-1", userId: "u1" },
      data: {
        lastSyncedAt: expect.any(Date),
        historyId: "https://graph.microsoft.com/v1.0/me/delta?token=new",
      },
    });

    m.updateMany.mockClear();
    m.syncOutlookInbox.mockResolvedValue(syncOk({ cursor: null }));
    await syncOutlookAccountsForUser("u1");
    const write = m.updateMany.mock.calls[0][0];
    expect(write.data).not.toHaveProperty("historyId");
  });

  it("refreshes when the token outlives the tick but not the NEXT tick (slack >= poll interval)", async () => {
    // 4 minutes left: still valid now, but dead before the next 5-minute
    // tick — returning it as "fresh" would 401 next tick and false-flag a
    // healthy account for reconnect.
    m.findMany.mockResolvedValue([outlookRow({ expiresAt: new Date(Date.now() + 4 * 60_000) })]);
    await syncOutlookAccountsForUser("u1");
    expect(m.refreshOutlookTokens).toHaveBeenCalled();
    expect(m.markLinkedInboxForReconnect).not.toHaveBeenCalled();
  });

  it("still syncs with the in-memory token when the rotated-cipher persist fails", async () => {
    // Losing a ROTATED refresh token to a transient DB blip must not lose
    // the tick too — the fresh access token is in memory and still valid.
    m.findMany.mockResolvedValue([outlookRow({ expiresAt: PAST })]);
    m.updateMany.mockRejectedValueOnce(new Error("db blip"));
    await syncOutlookAccountsForUser("u1");
    expect(m.syncOutlookInbox).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "new-at" }),
    );
    expect(m.markLinkedInboxForReconnect).not.toHaveBeenCalled();
  });

  it("an undecryptable refresh cipher does not discard a still-fresh access token", async () => {
    m.findMany.mockResolvedValue([outlookRow({ refreshToken: "BAD" })]);
    await syncOutlookAccountsForUser("u1");
    expect(m.syncOutlookInbox).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "plain:at-cipher" }),
    );
    expect(m.markLinkedInboxForReconnect).not.toHaveBeenCalled();
  });

  it("guards an access-only refresh write optimistically, but a rotation writes unconditionally", async () => {
    // Access-only (no rotated refresh token): a stale concurrent tick must
    // not clobber a newer token — mirror gmail's decideRefreshTokenWrite.
    m.refreshOutlookTokens.mockResolvedValue({
      accessToken: "new-at",
      refreshToken: null,
      expiresAt: FUTURE,
    });
    m.findMany.mockResolvedValue([outlookRow({ expiresAt: PAST })]);
    await syncOutlookAccountsForUser("u1");
    const guarded = m.updateMany.mock.calls.find((c) => c[0]?.data?.accessToken);
    expect(guarded?.[0].where).toMatchObject({
      id: "row-1",
      userId: "u1",
      OR: [{ expiresAt: null }, { expiresAt: { lt: FUTURE } }],
    });

    m.updateMany.mockClear();
    m.refreshOutlookTokens.mockResolvedValue({
      accessToken: "new-at",
      refreshToken: "new-rt",
      expiresAt: FUTURE,
    });
    await syncOutlookAccountsForUser("u1");
    const rotated = m.updateMany.mock.calls.find((c) => c[0]?.data?.accessToken);
    expect(rotated?.[0].where).toEqual({ id: "row-1", userId: "u1", refreshToken: "rt-cipher" });
  });

  it("an uncontended refresh behaves exactly as before: one refresh, one write, the new token syncs, nothing flagged", async () => {
    m.findMany.mockResolvedValue([outlookRow({ expiresAt: PAST })]);

    await syncOutlookAccountsForUser("u1");

    expect(m.refreshOutlookTokens).toHaveBeenCalledTimes(1);
    const writes = m.updateMany.mock.calls.filter((c) => c[0]?.data?.accessToken);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0].data).toEqual({
      accessToken: "enc:new-at",
      refreshToken: "enc:new-rt",
      expiresAt: FUTURE,
      needsReconnect: false,
    });
    expect(m.syncOutlookInbox).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "new-at" }),
    );
    expect(m.markLinkedInboxForReconnect).not.toHaveBeenCalled();
  });

  it("when another refresh stored first (the swap writes no row) it syncs with its own fresh token and flags nothing", async () => {
    m.findMany.mockResolvedValue([outlookRow({ expiresAt: PAST })]);
    m.updateMany.mockResolvedValueOnce({ count: 0 });

    await syncOutlookAccountsForUser("u1");

    expect(m.syncOutlookInbox).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "new-at" }),
    );
    expect(m.markLinkedInboxForReconnect).not.toHaveBeenCalled();
  });

  it("a refresh that rejects (a refused redirect, a timeout) is that account's error, and the next account still syncs", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    m.findMany.mockResolvedValue([
      outlookRow({ expiresAt: PAST }),
      outlookRow({ id: "row-2", email: "b@outlook.com" }),
    ]);
    m.refreshOutlookTokens.mockRejectedValueOnce(new TypeError("fetch failed"));

    const result = await syncOutlookAccountsForUser("u1");

    expect(result).toMatchObject({ errors: 1 });
    expect(m.syncOutlookInbox).toHaveBeenCalledTimes(1);
    expect(m.syncOutlookInbox).toHaveBeenCalledWith(
      expect.objectContaining({ linkedInboxAccountId: "row-2" }),
    );
    // A network failure is not a revoked grant: nothing is flagged.
    expect(m.markLinkedInboxForReconnect).not.toHaveBeenCalled();
  });

  it("one account failing never blocks the next, and errors aggregate", async () => {
    m.findMany.mockResolvedValue([
      outlookRow(),
      outlookRow({ id: "row-2", email: "b@outlook.com" }),
    ]);
    m.syncOutlookInbox
      .mockRejectedValueOnce(new Error("graph down"))
      .mockResolvedValueOnce(syncOk());
    const result = await syncOutlookAccountsForUser("u1");
    expect(m.syncOutlookInbox).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ fetched: 2, inserted: 1, errors: 1 });
  });
});
