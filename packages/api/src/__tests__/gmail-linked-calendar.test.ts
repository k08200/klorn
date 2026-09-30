import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * buildLinkedCalendarClient builds the OAuth2 client of ONE LINKED (secondary)
 * Google calendar account from the row the provider seam's dispatcher already
 * loaded, so a conflict check costs no read per account beyond the listing. A
 * corrupt row (undecryptable token) answers null, never crashes the conflict
 * check for the primary or other linked accounts.
 */

const m = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(async () => ({ count: 1 })),
}));

vi.mock("../db.js", () => ({
  prisma: {
    linkedCalendarAccount: {
      findFirst: m.findFirst,
      findMany: m.findMany,
      updateMany: m.updateMany,
    },
  },
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

import { buildLinkedCalendarClient, markLinkedCalendarForReconnect } from "../mail/gmail.js";

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "a",
  email: "work@x.com",
  accessToken: "AT1",
  refreshToken: "RT1",
  expiresAt: null,
  ...overrides,
});

describe("buildLinkedCalendarClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads nothing from the database: the row is already in hand", () => {
    buildLinkedCalendarClient("u1", row() as never);
    expect(m.findFirst).not.toHaveBeenCalled();
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it("returns the account's client tagged with its id and email", () => {
    const linked = buildLinkedCalendarClient("u1", row() as never);
    expect(linked?.id).toBe("a");
    expect(linked?.email).toBe("work@x.com");
    expect(linked?.client).toBeTruthy();
  });

  it("builds a client from an access token alone (no refresh token)", () => {
    const linked = buildLinkedCalendarClient(
      "u1",
      row({ id: "b", accessToken: "AT2", refreshToken: null }) as never,
    );
    expect(linked?.client).toBeTruthy();
  });

  it("answers null for a row whose token fails to decrypt AND flags it for reconnect", async () => {
    expect(
      buildLinkedCalendarClient(
        "u1",
        row({ id: "bad", accessToken: "BAD", refreshToken: null }) as never,
      ),
    ).toBeNull();
    // The corrupt row is durably flagged so the UI prompts a re-link (fire-and-
    // forget, so allow the microtask to settle before asserting).
    await Promise.resolve();
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { id: "bad", userId: "u1" },
      data: { needsReconnect: true },
    });
  });

  it("answers null for a row with no usable tokens AND flags it for reconnect (not silent rot)", async () => {
    expect(
      buildLinkedCalendarClient(
        "u1",
        row({ id: "empty", accessToken: "", refreshToken: null }) as never,
      ),
    ).toBeNull();
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
