/**
 * C4: the token lifecycle of an OUTLOOK LinkedCalendarAccount. Mirrors the
 * Outlook inbox lifecycle (mail/outlook-token.ts) over the calendar table:
 * decrypt, refresh when the access token is about to lapse, persist Microsoft's
 * ROTATED refresh token, and report a dead grant in the shape the shared
 * failure policy recognises (flag for reconnect, throttled warn, no Sentry).
 *
 * The refresh is lazy: `connect` only decrypts, so a revoked grant surfaces as a
 * rejection inside the caller's own try/catch, never as a throw out of the
 * dispatcher's loop (which would skip every other account).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  refreshOutlookTokens: vi.fn(),
  updateMany: vi.fn(async () => ({ count: 1 })),
  markLinkedCalendarForReconnect: vi.fn(async () => {}),
  captureError: vi.fn(),
  decryptFails: false,
  refreshDecryptFails: false,
}));

vi.mock("../crypto-tokens.js", () => ({
  decryptToken: (t: string) => {
    if (m.decryptFails) throw new Error("bad cipher");
    return t.replace(/^enc:/, "");
  },
  decryptOptional: (t: string | null | undefined) => {
    if (m.decryptFails || m.refreshDecryptFails) throw new Error("bad cipher");
    return t ? t.replace(/^enc:/, "") : null;
  },
  encryptToken: (t: string) => `enc:${t}`,
  encryptOptional: (t: string | null | undefined) => (t ? `enc:${t}` : null),
}));
vi.mock("../mail/outlook-oauth.js", () => ({ refreshOutlookTokens: m.refreshOutlookTokens }));
vi.mock("../db.js", () => {
  const prisma = { linkedCalendarAccount: { updateMany: m.updateMany } };
  return { prisma, db: prisma };
});
vi.mock("../mail/gmail.js", () => ({
  markLinkedCalendarForReconnect: m.markLinkedCalendarForReconnect,
}));
vi.mock("../sentry.js", () => ({ captureError: m.captureError }));

import { createOutlookCalendarTokenSource } from "../pim/calendar-providers/outlook-token.js";
import { isRevokedGrantError } from "../pim/linked-calendar-failure.js";

const HOUR = 60 * 60_000;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "acct-out",
    userId: "u1",
    provider: "OUTLOOK",
    email: "me@contoso.com",
    accessToken: "enc:access-1",
    refreshToken: "enc:refresh-1",
    expiresAt: new Date(Date.now() + HOUR),
    needsReconnect: false,
    ...overrides,
  };
}

function source(overrides: Record<string, unknown> = {}) {
  return createOutlookCalendarTokenSource("u1", row(overrides) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  m.decryptFails = false;
  m.refreshDecryptFails = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  m.refreshOutlookTokens.mockResolvedValue({
    accessToken: "access-2",
    refreshToken: "refresh-2",
    expiresAt: new Date("2026-10-01T10:00:00.000Z"),
  });
});

describe("a token with time left", () => {
  it("is used as stored, with no refresh and no write", async () => {
    const src = source();

    expect(await src?.accessToken()).toBe("access-1");

    expect(m.refreshOutlookTokens).not.toHaveBeenCalled();
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it("does not touch the network or the database just to open a source", () => {
    source();
    expect(m.refreshOutlookTokens).not.toHaveBeenCalled();
    expect(m.updateMany).not.toHaveBeenCalled();
  });
});

describe("a token about to lapse", () => {
  it.each([
    ["already expired", new Date(Date.now() - 1000)],
    ["inside the safety margin", new Date(Date.now() + 60_000)],
    ["with no expiry recorded", null],
  ])("is refreshed when it is %s, with the CALENDAR scope set", async (_label, expiresAt) => {
    const src = source({ expiresAt });

    expect(await src?.accessToken()).toBe("access-2");

    expect(m.refreshOutlookTokens).toHaveBeenCalledTimes(1);
    expect(m.refreshOutlookTokens).toHaveBeenCalledWith("refresh-1", "calendar");
  });

  it("persists the new access token AND Microsoft's rotated refresh token, scoped by id and user, clearing the flag", async () => {
    await source({ expiresAt: null, needsReconnect: true })?.accessToken();

    expect(m.updateMany).toHaveBeenCalledTimes(1);
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { id: "acct-out", userId: "u1" },
      data: {
        accessToken: "enc:access-2",
        refreshToken: "enc:refresh-2",
        expiresAt: new Date("2026-10-01T10:00:00.000Z"),
        needsReconnect: false,
      },
    });
  });

  it("keeps the stored refresh token when Microsoft sends no new one", async () => {
    m.refreshOutlookTokens.mockResolvedValue({
      accessToken: "access-2",
      refreshToken: null,
      expiresAt: new Date("2026-10-01T10:00:00.000Z"),
    });

    await source({ expiresAt: null })?.accessToken();

    const arg = (
      m.updateMany.mock.calls[0] as unknown as [
        { where: Record<string, unknown>; data: Record<string, unknown> },
      ]
    )[0];
    expect(arg.data).not.toHaveProperty("refreshToken");
    expect(arg.data.accessToken).toBe("enc:access-2");
    // An access-only refresh must not overwrite a newer token a concurrent tick stored.
    expect(arg.where.OR).toEqual([
      { expiresAt: null },
      { expiresAt: { lt: new Date("2026-10-01T10:00:00.000Z") } },
    ]);
  });

  it("refreshes once per source, however many calls one session makes", async () => {
    const src = source({ expiresAt: null });

    const tokens = await Promise.all([src?.accessToken(), src?.accessToken(), src?.accessToken()]);

    expect(tokens).toEqual(["access-2", "access-2", "access-2"]);
    expect(m.refreshOutlookTokens).toHaveBeenCalledTimes(1);
    expect(m.updateMany).toHaveBeenCalledTimes(1);
  });

  it("still returns the fresh token when saving it fails, and reports the failure", async () => {
    m.updateMany.mockRejectedValueOnce(new Error("db blip"));

    expect(await source({ expiresAt: null })?.accessToken()).toBe("access-2");

    expect(m.captureError).toHaveBeenCalledTimes(1);
    expect(m.captureError.mock.calls[0]?.[1]).toMatchObject({
      tags: { scope: "outlook-calendar.token-persist" },
    });
  });
});

describe("a dead grant", () => {
  it.each([
    "invalid_grant",
    "interaction_required",
    "unauthorized_client",
  ])("a refresh answered %s rejects in the revoked-grant shape", async (code) => {
    m.refreshOutlookTokens.mockResolvedValue({ error: code });

    const err = await source({ expiresAt: null })
      ?.accessToken()
      .catch((e: unknown) => e);

    expect(isRevokedGrantError(err)).toBe(true);
    expect((err as Error).message).toContain(code);
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it("an expired token with no refresh token rejects the same way: only a re-link fixes it", async () => {
    const err = await source({ expiresAt: null, refreshToken: null })
      ?.accessToken()
      .catch((e: unknown) => e);

    expect(isRevokedGrantError(err)).toBe(true);
    expect(m.refreshOutlookTokens).not.toHaveBeenCalled();
  });

  it.each([
    "server_error",
    "temporarily_unavailable",
    "invalid_client",
    "token_refresh_failed",
  ])("a refresh answered %s is NOT a revoked grant: it stays a reportable failure", async (code) => {
    m.refreshOutlookTokens.mockResolvedValue({ error: code });

    const err = await source({ expiresAt: null })
      ?.accessToken()
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(isRevokedGrantError(err)).toBe(false);
  });

  it("a failed refresh is retried by the next source, not remembered forever", async () => {
    m.refreshOutlookTokens.mockResolvedValueOnce({ error: "invalid_grant" });
    const first = source({ expiresAt: null });
    await first?.accessToken().catch(() => {});

    expect(await source({ expiresAt: null })?.accessToken()).toBe("access-2");
  });
});

describe("an unusable row", () => {
  it("answers null and flags the account for reconnect when the token cannot be decrypted", () => {
    m.decryptFails = true;

    expect(source()).toBeNull();
    expect(m.markLinkedCalendarForReconnect).toHaveBeenCalledWith("u1", "acct-out");
  });

  it("answers null and flags the account when it holds no token at all", () => {
    expect(source({ accessToken: null, refreshToken: null })).toBeNull();
    expect(m.markLinkedCalendarForReconnect).toHaveBeenCalledWith("u1", "acct-out");
  });

  it("a failing flag write is logged, not thrown", async () => {
    m.decryptFails = true;
    m.markLinkedCalendarForReconnect.mockRejectedValueOnce(new Error("db blip"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(source()).toBeNull();
    await Promise.resolve();
    await Promise.resolve();

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("refreshes from the refresh token alone when there is no access token yet", async () => {
    expect(await source({ accessToken: null })?.accessToken()).toBe("access-2");
    expect(m.refreshOutlookTokens).toHaveBeenCalledWith("refresh-1", "calendar");
  });
});

describe("a rotten refresh cipher", () => {
  it("does not flag the account while the access token still works: the mail path's rule", async () => {
    m.refreshDecryptFails = true;

    const src = source();

    expect(src).not.toBeNull();
    expect(await src?.accessToken()).toBe("access-1");
    expect(m.markLinkedCalendarForReconnect).not.toHaveBeenCalled();
    expect(m.refreshOutlookTokens).not.toHaveBeenCalled();
  });

  it("surfaces as a revoked grant once the access token runs out, which is when the policy flags it", async () => {
    m.refreshDecryptFails = true;

    const err = await source({ expiresAt: new Date(Date.now() - 1000) })
      ?.accessToken()
      .catch((e: unknown) => e);

    expect(isRevokedGrantError(err)).toBe(true);
    expect(m.refreshOutlookTokens).not.toHaveBeenCalled();
  });

  it("an undecryptable ACCESS token still flags at once", () => {
    m.decryptFails = true;

    expect(source()).toBeNull();
    expect(m.markLinkedCalendarForReconnect).toHaveBeenCalledWith("u1", "acct-out");
  });
});

describe("renewAfterUnauthorized(failedToken)", () => {
  it("forces a refresh even though the stored token looked fresh, and answers the new token", async () => {
    const src = source();
    const failed = await src?.accessToken();

    expect(await src?.renewAfterUnauthorized(failed ?? "")).toBe("access-2");

    expect(m.refreshOutlookTokens).toHaveBeenCalledWith("refresh-1", "calendar");
    expect(m.updateMany).toHaveBeenCalledTimes(1);
    expect(await src?.accessToken()).toBe("access-2");
  });

  it("answers null when the token in use already came from a refresh: the 401 is real", async () => {
    const src = source({ expiresAt: null });
    const failed = await src?.accessToken();

    expect(await src?.renewAfterUnauthorized(failed ?? "")).toBeNull();
    expect(m.refreshOutlookTokens).toHaveBeenCalledTimes(1);
  });

  it("refreshes at most once per source, even across repeated 401s", async () => {
    const src = source();
    const first = await src?.accessToken();
    await src?.renewAfterUnauthorized(first ?? "");

    expect(await src?.renewAfterUnauthorized("access-2")).toBeNull();
    expect(m.refreshOutlookTokens).toHaveBeenCalledTimes(1);
  });

  it("hands back the newer token when the failed one is already stale, without a second refresh", async () => {
    const src = source();
    const first = await src?.accessToken();
    await src?.renewAfterUnauthorized(first ?? "");

    expect(await src?.renewAfterUnauthorized(first ?? "")).toBe("access-2");
    expect(m.refreshOutlookTokens).toHaveBeenCalledTimes(1);
  });

  it("rejects in the revoked-grant shape when the refresh is refused", async () => {
    m.refreshOutlookTokens.mockResolvedValue({ error: "invalid_grant" });
    const src = source();

    const err = await src?.renewAfterUnauthorized("access-1").catch((e: unknown) => e);

    expect(isRevokedGrantError(err)).toBe(true);
  });

  it("rejects the same way when there is no refresh token to force", async () => {
    const src = source({ refreshToken: null });

    const err = await src?.renewAfterUnauthorized("access-1").catch((e: unknown) => e);

    expect(isRevokedGrantError(err)).toBe(true);
    expect(m.refreshOutlookTokens).not.toHaveBeenCalled();
  });
});
