import { describe, expect, it } from "vitest";
import type { JwtPayload } from "../auth.js";
import {
  comparePassword,
  hashPassword,
  isTokenRevokedByEpoch,
  signToken,
  verifyToken,
} from "../auth.js";

describe("signToken / verifyToken", () => {
  it("round-trips a payload through sign/verify", () => {
    const token = signToken({ userId: "u-1", email: "a@b.com" });
    const decoded = verifyToken(token);
    expect(decoded.userId).toBe("u-1");
    expect(decoded.email).toBe("a@b.com");
  });

  it("rejects a tampered token", () => {
    const token = signToken({ userId: "u-1", email: "a@b.com" });
    const parts = token.split(".");
    const badSig = `${"A".repeat(parts[2].length)}`;
    const tampered = `${parts[0]}.${parts[1]}.${badSig}`;
    expect(() => verifyToken(tampered)).toThrow();
  });

  it("rejects garbage input", () => {
    expect(() => verifyToken("not-a-jwt")).toThrow();
  });
});

describe("hashPassword / comparePassword", () => {
  it("produces a hash that verifies against the original password", async () => {
    const hash = await hashPassword("hunter2");
    expect(hash).not.toBe("hunter2");
    expect(await comparePassword("hunter2", hash)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("hunter2");
    expect(await comparePassword("hunter3", hash)).toBe(false);
  });

  it("uses a random salt — the same input hashes to different values", async () => {
    const a = await hashPassword("hunter2");
    const b = await hashPassword("hunter2");
    expect(a).not.toBe(b);
  });
});

describe("isTokenRevokedByEpoch (password-reset session revocation)", () => {
  const epochSeconds = 1_700_000_000; // fixed instant, whole seconds
  const epoch = new Date(epochSeconds * 1000);
  const base: JwtPayload = { userId: "u-1", email: "a@b.com" };

  it("treats a token as live when the user has no revocation epoch", () => {
    expect(isTokenRevokedByEpoch({ ...base, iat: epochSeconds } as JwtPayload, null)).toBe(false);
    expect(isTokenRevokedByEpoch({ ...base, iat: epochSeconds } as JwtPayload, undefined)).toBe(
      false,
    );
  });

  it("revokes a token issued before the reset (the stolen-token case)", () => {
    const stolen = { ...base, iat: epochSeconds - 60 } as JwtPayload; // minted 1 min earlier
    expect(isTokenRevokedByEpoch(stolen, epoch)).toBe(true);
  });

  it("keeps a token issued after the reset (the fresh re-login)", () => {
    const fresh = { ...base, iat: epochSeconds + 5 } as JwtPayload;
    expect(isTokenRevokedByEpoch(fresh, epoch)).toBe(false);
  });

  it("keeps a token minted in the same second as the reset (favor availability)", () => {
    const sameSecond = { ...base, iat: epochSeconds } as JwtPayload;
    expect(isTokenRevokedByEpoch(sameSecond, epoch)).toBe(false);
  });

  it("does not revoke a payload missing iat (fails open, never locks a valid token out)", () => {
    expect(isTokenRevokedByEpoch(base, epoch)).toBe(false);
  });

  it("revokes a real signed token whose iat predates a later epoch", () => {
    // A token signed now, then the user resets ~an hour later.
    const decoded = verifyToken(signToken({ userId: "u-9", email: "x@y.com" }));
    const laterReset = new Date((decoded as { iat: number }).iat * 1000 + 3_600_000);
    expect(isTokenRevokedByEpoch(decoded, laterReset)).toBe(true);
  });
});
