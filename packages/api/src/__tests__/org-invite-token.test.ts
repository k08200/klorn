/**
 * Org invite tokens (Klorn Teams v1): only the SHA-256 of the token is stored,
 * the raw token is 256 random bits, and anything not shaped like a token is
 * refused before a lookup.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hashInviteToken,
  INVITE_TTL_MS,
  inviteExpiry,
  isWellFormedInviteToken,
  mintInviteToken,
} from "../org/invite-token.js";

describe("org invite tokens", () => {
  it("mints a 64-hex raw token and stores only its SHA-256", () => {
    const { token, tokenHash } = mintInviteToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(tokenHash).not.toBe(token);
    expect(hashInviteToken(token)).toBe(tokenHash);
  });

  it("never mints the same token twice", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => mintInviteToken().token));
    expect(tokens.size).toBe(50);
  });

  it("accepts only the minted shape", () => {
    expect(isWellFormedInviteToken(mintInviteToken().token)).toBe(true);
    for (const bad of [
      "",
      "abc",
      "z".repeat(64),
      "A".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      ` ${"a".repeat(64)}`,
      null,
      undefined,
      42,
      { token: "a".repeat(64) },
    ]) {
      expect(isWellFormedInviteToken(bad)).toBe(false);
    }
  });

  it("expires seven days after it is issued", () => {
    const now = new Date("2026-11-14T00:00:00.000Z");
    expect(INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(inviteExpiry(now).toISOString()).toBe("2026-11-21T00:00:00.000Z");
  });
});
