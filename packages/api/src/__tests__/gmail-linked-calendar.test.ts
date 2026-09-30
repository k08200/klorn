import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * getLinkedCalendarClient loads the OAuth2 client of ONE LINKED (secondary) Google
 * calendar account, for the provider seam's `connect` (conflict checks and the
 * linked sync both go through it). A corrupt row (undecryptable token) answers
 * null, never crashes the conflict check for the primary or other linked accounts.
 */

const m = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(async () => ({ count: 1 })),
}));

vi.mock("../db.js", () => ({
  prisma: { linkedCalendarAccount: { findFirst: m.findFirst, updateMany: m.updateMany } },
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

import { getLinkedCalendarClient, markLinkedCalendarForReconnect } from "../mail/gmail.js";

describe("getLinkedCalendarClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks only for this user's GOOGLE row — a CalDAV row has no token and an OUTLOOK row is not a Google client", async () => {
    m.findFirst.mockResolvedValue(null);
    await getLinkedCalendarClient("u1", "a");
    expect(m.findFirst).toHaveBeenCalledWith({
      where: { id: "a", userId: "u1", provider: "GOOGLE" },
    });
  });

  it("returns the account's client tagged with its id and email", async () => {
    m.findFirst.mockResolvedValue({
      id: "a",
      email: "work@x.com",
      accessToken: "AT1",
      refreshToken: "RT1",
      expiresAt: null,
    });
    const linked = await getLinkedCalendarClient("u1", "a");
    expect(linked?.id).toBe("a");
    expect(linked?.email).toBe("work@x.com");
    expect(linked?.client).toBeTruthy();
  });

  it("builds a client from an access token alone (no refresh token)", async () => {
    m.findFirst.mockResolvedValue({
      id: "b",
      email: "side@y.com",
      accessToken: "AT2",
      refreshToken: null,
      expiresAt: null,
    });
    expect((await getLinkedCalendarClient("u1", "b"))?.client).toBeTruthy();
  });

  it("answers null for an id the user does not have", async () => {
    m.findFirst.mockResolvedValue(null);
    expect(await getLinkedCalendarClient("u1", "someone-elses")).toBeNull();
  });

  it("answers null for a row whose token fails to decrypt AND flags it for reconnect", async () => {
    m.findFirst.mockResolvedValue({
      id: "bad",
      email: "bad@x.com",
      accessToken: "BAD",
      refreshToken: null,
      expiresAt: null,
    });
    expect(await getLinkedCalendarClient("u1", "bad")).toBeNull();
    // The corrupt row is durably flagged so the UI prompts a re-link (fire-and-
    // forget, so allow the microtask to settle before asserting).
    await Promise.resolve();
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { id: "bad", userId: "u1" },
      data: { needsReconnect: true },
    });
  });

  it("answers null for a row with no usable tokens AND flags it for reconnect (not silent rot)", async () => {
    m.findFirst.mockResolvedValue({
      id: "empty",
      email: "e@x.com",
      accessToken: "",
      refreshToken: null,
      expiresAt: null,
    });
    expect(await getLinkedCalendarClient("u1", "empty")).toBeNull();
    await Promise.resolve();
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { id: "empty", userId: "u1" },
      data: { needsReconnect: true },
    });
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
