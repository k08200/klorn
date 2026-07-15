import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * getLinkedCalendarClients loads one OAuth2 client per LINKED (secondary) Google
 * account for cross-account free/busy. A corrupt row (undecryptable token) must
 * be skipped, never crash the conflict check for the primary or other linked
 * accounts.
 */

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(async () => ({ count: 1 })),
}));

vi.mock("../db.js", () => ({
  prisma: { linkedCalendarAccount: { findMany: m.findMany, updateMany: m.updateMany } },
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
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

import { getLinkedCalendarClients, markLinkedCalendarForReconnect } from "../mail/gmail.js";

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

  it("returns each client's id (needed to flag the right account for reconnect)", async () => {
    m.findMany.mockResolvedValue([
      { id: "a", email: "work@x.com", accessToken: "AT", refreshToken: "RT", expiresAt: null },
    ]);
    const clients = await getLinkedCalendarClients("u1");
    expect(clients[0]?.id).toBe("a");
  });

  it("skips a row whose token fails to decrypt AND flags it for reconnect", async () => {
    m.findMany.mockResolvedValue([
      { id: "bad", email: "bad@x.com", accessToken: "BAD", refreshToken: null, expiresAt: null },
      { id: "ok", email: "ok@x.com", accessToken: "AT", refreshToken: "RT", expiresAt: null },
    ]);
    const clients = await getLinkedCalendarClients("u1");
    expect(clients.map((c) => c.email)).toEqual(["ok@x.com"]);
    // The corrupt row is durably flagged so the UI prompts a re-link (fire-and-
    // forget, so allow the microtask to settle before asserting).
    await Promise.resolve();
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { id: "bad", userId: "u1" },
      data: { needsReconnect: true },
    });
  });

  it("skips a row with no usable tokens AND flags it for reconnect (not silent rot)", async () => {
    m.findMany.mockResolvedValue([
      { id: "empty", email: "e@x.com", accessToken: "", refreshToken: null, expiresAt: null },
    ]);
    expect(await getLinkedCalendarClients("u1")).toEqual([]);
    await Promise.resolve();
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { id: "empty", userId: "u1" },
      data: { needsReconnect: true },
    });
  });

  it("returns [] when the user has no linked accounts", async () => {
    m.findMany.mockResolvedValue([]);
    expect(await getLinkedCalendarClients("u1")).toEqual([]);
  });
});

describe("markLinkedCalendarForReconnect", () => {
  beforeEach(() => vi.clearAllMocks());

  it("durably flags ONE linked calendar scoped by (id, userId)", async () => {
    await markLinkedCalendarForReconnect("u1", "cal-1");
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { id: "cal-1", userId: "u1" },
      data: { needsReconnect: true },
    });
  });
});
