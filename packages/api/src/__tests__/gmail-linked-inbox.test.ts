import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * getLinkedInboxClients loads one OAuth2 client per LINKED (secondary) full
 * inbox for multi-account sync. A corrupt row (undecryptable token) must be
 * skipped, never crash the sync for the primary or other linked accounts —
 * mirrors the linked-calendar client loader.
 */

const m = vi.hoisted(() => ({ findMany: vi.fn(), findFirst: vi.fn() }));

vi.mock("../db.js", () => ({
  prisma: { linkedInboxAccount: { findMany: m.findMany, findFirst: m.findFirst } },
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

import { getAuthedInboxClient, getLinkedInboxClients } from "../gmail.js";

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

  it("skips a row with no usable tokens", async () => {
    m.findMany.mockResolvedValue([
      { id: "empty", email: "e@x.com", accessToken: "", refreshToken: null, expiresAt: null },
    ]);
    expect(await getLinkedInboxClients("u1")).toEqual([]);
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
