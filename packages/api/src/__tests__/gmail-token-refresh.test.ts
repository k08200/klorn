import { describe, expect, it } from "vitest";
import { decideRefreshTokenWrite } from "../mail/gmail.js";

describe("decideRefreshTokenWrite", () => {
  it("skips an empty callback (no access_token and no refresh_token)", () => {
    expect(decideRefreshTokenWrite({})).toEqual({
      write: false,
      reason: "noop_empty_callback",
    });
  });

  it("rotates unconditionally when a new refresh_token is present", () => {
    const expiry = Date.now() + 60_000;
    const decision = decideRefreshTokenWrite({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expiry_date: expiry,
    });
    expect(decision).toMatchObject({
      write: true,
      mode: "rotate",
      accessTokenPlain: "new-access",
      refreshTokenPlain: "new-refresh",
    });
    if (decision.write && decision.mode === "rotate") {
      expect(decision.expiresAt?.getTime()).toBe(expiry);
    }
  });

  it("rotates even without an expiry_date — old refresh_token is revoked the instant Google issues a new one", () => {
    const decision = decideRefreshTokenWrite({
      refresh_token: "new-refresh",
    });
    expect(decision).toMatchObject({
      write: true,
      mode: "rotate",
      refreshTokenPlain: "new-refresh",
      expiresAt: null,
    });
  });

  it("uses optimistic write when only access_token + expiry are present", () => {
    const expiry = Date.now() + 60_000;
    const decision = decideRefreshTokenWrite({
      access_token: "new-access",
      expiry_date: expiry,
    });
    expect(decision).toMatchObject({
      write: true,
      mode: "optimistic",
      accessTokenPlain: "new-access",
    });
    if (decision.write && decision.mode === "optimistic") {
      expect(decision.expiresAt.getTime()).toBe(expiry);
    }
  });

  it("refuses to write an access_token with no expiry — can't reason about staleness", () => {
    expect(decideRefreshTokenWrite({ access_token: "new-access" })).toEqual({
      write: false,
      reason: "noop_no_expiry",
    });
  });

  it("treats a null access_token with rotation as a rotation with empty access", () => {
    // Edge case: Google occasionally returns refresh_token without access_token
    const decision = decideRefreshTokenWrite({
      access_token: null,
      refresh_token: "new-refresh",
      expiry_date: Date.now() + 60_000,
    });
    expect(decision.write).toBe(true);
    if (decision.write && decision.mode === "rotate") {
      expect(decision.accessTokenPlain).toBe("");
      expect(decision.refreshTokenPlain).toBe("new-refresh");
    }
  });
});
