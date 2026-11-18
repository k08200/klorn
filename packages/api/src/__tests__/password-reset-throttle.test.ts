import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetPasswordResetThrottleForTests,
  PASSWORD_RESET_MAX_REQUESTS,
  PASSWORD_RESET_REUSE_MS,
  PASSWORD_RESET_TOKEN_TTL_MS,
  PASSWORD_RESET_WINDOW_MS,
  passwordResetThrottleRemainingMs,
  recordPasswordResetRequest,
  resetLinkIsFresh,
} from "../security/password-reset-throttle.js";

const NOW = new Date("2026-11-18T09:00:00.000Z").getTime();
/** A stored link issued `ageMs` before NOW. */
const issuedAgo = (ageMs: number) => ({
  resetToken: "a".repeat(64),
  resetTokenExp: new Date(NOW - ageMs + PASSWORD_RESET_TOKEN_TTL_MS),
});

describe("resetLinkIsFresh", () => {
  it("is fresh just after the link was issued", () => {
    expect(resetLinkIsFresh(issuedAgo(0), NOW)).toBe(true);
    expect(resetLinkIsFresh(issuedAgo(PASSWORD_RESET_REUSE_MS - 1), NOW)).toBe(true);
  });

  it("is not fresh from PASSWORD_RESET_REUSE_MS on", () => {
    expect(resetLinkIsFresh(issuedAgo(PASSWORD_RESET_REUSE_MS), NOW)).toBe(false);
    expect(resetLinkIsFresh(issuedAgo(PASSWORD_RESET_TOKEN_TTL_MS - 1), NOW)).toBe(false);
  });

  it("is not fresh without a stored link, or once it expired", () => {
    expect(resetLinkIsFresh({ resetToken: null, resetTokenExp: null }, NOW)).toBe(false);
    expect(resetLinkIsFresh({ resetToken: null, resetTokenExp: new Date(NOW + 1) }, NOW)).toBe(
      false,
    );
    expect(resetLinkIsFresh({ resetToken: "x", resetTokenExp: null }, NOW)).toBe(false);
    expect(resetLinkIsFresh({ resetToken: "x", resetTokenExp: new Date(NOW) }, NOW)).toBe(false);
  });
});

describe("password reset window", () => {
  beforeEach(() => _resetPasswordResetThrottleForTests());

  it("locks an address after PASSWORD_RESET_MAX_REQUESTS for the rest of the window", () => {
    const key = "window@example.com";
    for (let i = 0; i < PASSWORD_RESET_MAX_REQUESTS; i++) {
      expect(passwordResetThrottleRemainingMs(key)).toBe(0);
      recordPasswordResetRequest(key);
    }
    const remaining = passwordResetThrottleRemainingMs(key);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(PASSWORD_RESET_WINDOW_MS);
    expect(passwordResetThrottleRemainingMs("other@example.com")).toBe(0);
  });

  it("lasts as long as a link lives, so the newest mailed link outlives a lock", () => {
    expect(PASSWORD_RESET_WINDOW_MS).toBe(PASSWORD_RESET_TOKEN_TTL_MS);
    expect(PASSWORD_RESET_REUSE_MS).toBeLessThan(PASSWORD_RESET_TOKEN_TTL_MS);
  });
});
