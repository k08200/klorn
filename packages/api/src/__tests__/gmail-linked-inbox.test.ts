import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * getLinkedInboxClients loads one OAuth2 client per LINKED (secondary) full
 * inbox for multi-account sync. A corrupt row (undecryptable token) must be
 * skipped, never crash the sync for the primary or other linked accounts —
 * mirrors the linked-calendar client loader.
 */

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
  updateMany: vi.fn(async () => ({ count: 1 })),
  userTokenFindFirst: vi.fn(),
}));

vi.mock("../db.js", () => ({
  prisma: {
    linkedInboxAccount: { findMany: m.findMany, findFirst: m.findFirst, updateMany: m.updateMany },
    userToken: { findFirst: m.userTokenFindFirst },
  },
}));
vi.mock("../crypto-tokens.js", () => ({
  decryptToken: (v: string) => {
    if (v === "BAD") throw new Error("decrypt fail");
    return `plain:${v}`;
  },
  decryptOptional: (v: string | null) => (v ? `plain:${v}` : null),
  encryptToken: (v: string) => `enc:${v}`,
  encryptOptional: (v: string | null) => (v ? `enc:${v}` : null),
}));
vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
        on() {}
      },
    },
  },
}));

import {
  getAuthedInboxClient,
  getLinkedInboxClients,
  markLinkedInboxForReconnect,
} from "../mail/gmail.js";

describe("getLinkedInboxClients", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns one client per linked inbox, tagged with its id + email", async () => {
    m.findMany.mockResolvedValue([
      { id: "a", email: "work@x.com", accessToken: "AT1", refreshToken: "RT1", expiresAt: null },
      { id: "b", email: "side@y.com", accessToken: "AT2", refreshToken: null, expiresAt: null },
    ]);
    const clients = await getLinkedInboxClients("u1");
    expect(clients).toHaveLength(2);
    expect(clients.map((c) => c.id)).toEqual(["a", "b"]);
    expect(clients.map((c) => c.email)).toEqual(["work@x.com", "side@y.com"]);
    expect(clients[0]?.client).toBeTruthy();
  });

  it("skips a row whose token fails to decrypt (corrupt row must not break the others)", async () => {
    m.findMany.mockResolvedValue([
      { id: "bad", email: "bad@x.com", accessToken: "BAD", refreshToken: null, expiresAt: null },
      { id: "ok", email: "ok@x.com", accessToken: "AT", refreshToken: "RT", expiresAt: null },
    ]);
    const clients = await getLinkedInboxClients("u1");
    expect(clients.map((c) => c.id)).toEqual(["ok"]);
  });

  it("skips a row with no usable tokens AND flags it for reconnect (not silent rot)", async () => {
    m.findMany.mockResolvedValue([
      { id: "empty", email: "e@x.com", accessToken: "", refreshToken: null, expiresAt: null },
    ]);
    expect(await getLinkedInboxClients("u1")).toEqual([]);
    // Empty tokens => flag for reconnect so the inbox surfaces a re-link prompt
    // instead of silently vanishing from the sync fan-out (fire-and-forget).
    await Promise.resolve();
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { id: "empty", userId: "u1" },
      data: { needsReconnect: true },
    });
  });

  it("returns [] when the user has no linked inboxes", async () => {
    m.findMany.mockResolvedValue([]);
    expect(await getLinkedInboxClients("u1")).toEqual([]);
  });
});

describe("getAuthedInboxClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a client for one linked inbox scoped by (id, userId)", async () => {
    m.findFirst.mockResolvedValue({
      id: "a",
      email: "work@x.com",
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: null,
    });
    const client = await getAuthedInboxClient("u1", "a");
    expect(client).toBeTruthy();
    expect(m.findFirst).toHaveBeenCalledWith({ where: { id: "a", userId: "u1" } });
  });

  it("returns null when the row is missing (wrong user or deleted)", async () => {
    m.findFirst.mockResolvedValue(null);
    expect(await getAuthedInboxClient("u1", "nope")).toBeNull();
  });

  it("returns null when the token can't be decrypted", async () => {
    m.findFirst.mockResolvedValue({
      id: "a",
      email: "x@x.com",
      accessToken: "BAD",
      refreshToken: null,
      expiresAt: null,
    });
    expect(await getAuthedInboxClient("u1", "a")).toBeNull();
  });
});

describe("mail actions route to the correct account (P2b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("archiveEmail with a linkedInboxAccountId resolves the LINKED inbox, never the primary token", async () => {
    // Linked row doesn't resolve → returns not-connected and stops. The point:
    // it looked up linkedInboxAccount by (id, userId) and NEVER touched the
    // primary userToken. Proves the linkedInboxAccountId routes to the linked
    // client (getAuthedInboxClient), not getAuthedClient.
    m.findFirst.mockResolvedValue(null);
    const { archiveEmail } = await import("../mail/gmail.js");
    const result = await archiveEmail("u1", "gmail-123", "acc-1");
    expect(result).toEqual({ error: "Gmail not connected." });
    expect(m.findFirst).toHaveBeenCalledWith({ where: { id: "acc-1", userId: "u1" } });
    expect(m.userTokenFindFirst).not.toHaveBeenCalled();
  });

  it("archiveEmail without a linkedInboxAccountId uses the PRIMARY token path", async () => {
    m.userTokenFindFirst.mockResolvedValue(null); // primary not connected → early return
    const { archiveEmail } = await import("../mail/gmail.js");
    const result = await archiveEmail("u1", "gmail-123");
    expect(result).toEqual({ error: "Gmail not connected." });
    expect(m.userTokenFindFirst).toHaveBeenCalled();
    expect(m.findFirst).not.toHaveBeenCalled();
  });
});

describe("markLinkedInboxForReconnect", () => {
  beforeEach(() => vi.clearAllMocks());

  it("durably flags ONE linked inbox scoped by (id, userId), never touching another account", async () => {
    await markLinkedInboxForReconnect("u1", "acc-1");

    // Scoped by BOTH id and userId so a caller can only flag its own linked row,
    // and sets the durable needsReconnect flag (not the primary token).
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { id: "acc-1", userId: "u1" },
      data: { needsReconnect: true },
    });
    expect(m.userTokenFindFirst).not.toHaveBeenCalled();
  });
});
