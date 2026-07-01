import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * getLinkedCalendarClients loads one OAuth2 client per LINKED (secondary) Google
 * account for cross-account free/busy. A corrupt row (undecryptable token) must
 * be skipped, never crash the conflict check for the primary or other linked
 * accounts.
 */

const m = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("../db.js", () => ({ prisma: { linkedCalendarAccount: { findMany: m.findMany } } }));
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

import { getLinkedCalendarClients } from "../gmail.js";

describe("getLinkedCalendarClients", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns one client per linked account, tagged with its email", async () => {
    m.findMany.mockResolvedValue([
      { id: "a", email: "work@x.com", accessToken: "AT1", refreshToken: "RT1", expiresAt: null },
      { id: "b", email: "side@y.com", accessToken: "AT2", refreshToken: null, expiresAt: null },
    ]);
    const clients = await getLinkedCalendarClients("u1");
    expect(clients).toHaveLength(2);
    expect(clients.map((c) => c.email)).toEqual(["work@x.com", "side@y.com"]);
    expect(clients[0]?.client).toBeTruthy();
  });

  it("skips a row whose token fails to decrypt (corrupt row must not break the others)", async () => {
    m.findMany.mockResolvedValue([
      { id: "bad", email: "bad@x.com", accessToken: "BAD", refreshToken: null, expiresAt: null },
      { id: "ok", email: "ok@x.com", accessToken: "AT", refreshToken: "RT", expiresAt: null },
    ]);
    const clients = await getLinkedCalendarClients("u1");
    expect(clients.map((c) => c.email)).toEqual(["ok@x.com"]);
  });

  it("skips a row with no usable tokens", async () => {
    m.findMany.mockResolvedValue([
      { id: "empty", email: "e@x.com", accessToken: "", refreshToken: null, expiresAt: null },
    ]);
    expect(await getLinkedCalendarClients("u1")).toEqual([]);
  });

  it("returns [] when the user has no linked accounts", async () => {
    m.findMany.mockResolvedValue([]);
    expect(await getLinkedCalendarClients("u1")).toEqual([]);
  });
});
