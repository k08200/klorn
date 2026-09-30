/**
 * The token write both Outlook token lifecycles share (mail/outlook-token.ts over
 * LinkedInboxAccount, pim/calendar-providers/outlook-token.ts over
 * LinkedCalendarAccount): what a refreshed token pair is saved as, and the guard
 * that keeps an access-only refresh from overwriting a newer token. Only the
 * table and the reconnect marker differ between the callers, so the rule lives
 * in one pure function and each caller's own test pins that it uses it.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../crypto-tokens.js", () => ({
  encryptToken: (t: string) => `enc:${t}`,
  encryptOptional: (t: string | null | undefined) => (t ? `enc:${t}` : null),
}));

import { refreshedTokenUpdate } from "../mail/outlook-token-update.js";

const EXPIRES = new Date("2026-10-01T10:00:00.000Z");

describe("refreshedTokenUpdate", () => {
  it("a rotation saves both ciphers unconditionally: the old refresh token is already dead", () => {
    expect(
      refreshedTokenUpdate({ accessToken: "a2", refreshToken: "r2", expiresAt: EXPIRES }),
    ).toEqual({
      where: {},
      data: {
        accessToken: "enc:a2",
        refreshToken: "enc:r2",
        expiresAt: EXPIRES,
        needsReconnect: false,
      },
    });
  });

  it("an access-only refresh keeps the stored refresh token and only replaces an older access token", () => {
    const update = refreshedTokenUpdate({
      accessToken: "a2",
      refreshToken: null,
      expiresAt: EXPIRES,
    });

    expect(update.data).toEqual({
      accessToken: "enc:a2",
      expiresAt: EXPIRES,
      needsReconnect: false,
    });
    expect(update.data).not.toHaveProperty("refreshToken");
    expect(update.where).toEqual({ OR: [{ expiresAt: null }, { expiresAt: { lt: EXPIRES } }] });
  });

  it("an access-only refresh with no expiry has nothing to compare, so no guard", () => {
    const update = refreshedTokenUpdate({ accessToken: "a2", refreshToken: null, expiresAt: null });

    expect(update.where).toEqual({});
    expect(update.data).toEqual({ accessToken: "enc:a2", expiresAt: null, needsReconnect: false });
  });

  it("a healthy refresh always clears the reconnect flag", () => {
    for (const refreshToken of ["r2", null]) {
      expect(
        refreshedTokenUpdate({ accessToken: "a2", refreshToken, expiresAt: EXPIRES }).data
          .needsReconnect,
      ).toBe(false);
    }
  });

  it("does not modify what it is given", () => {
    const refreshed = Object.freeze({ accessToken: "a2", refreshToken: "r2", expiresAt: EXPIRES });

    expect(() => refreshedTokenUpdate(refreshed)).not.toThrow();
    expect(refreshed.accessToken).toBe("a2");
  });
});
