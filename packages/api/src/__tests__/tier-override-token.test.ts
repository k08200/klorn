import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { signToken } from "../auth.js";
import { mintTierOverrideToken, verifyTierOverrideToken } from "../tier-override-token.js";

// Recompute the derived secret the module uses (white-box) so a test can mint a
// validly-signed token with a wrong `kind` to prove kind enforcement, not just
// signature enforcement. Tests run without JWT_SECRET → the dev fallback.
const BASE_SECRET = process.env.JWT_SECRET || "klorn-dev-secret-do-not-use-in-production";
const OVERRIDE_SECRET = createHmac("sha256", BASE_SECRET).update("tier-override-v1").digest("hex");

describe("tier-override-token", () => {
  it("round-trips a minted token back to its userId, itemId, and permitted tiers", () => {
    const token = mintTierOverrideToken("user-1", "item-9");
    expect(verifyTierOverrideToken(token)).toEqual({
      userId: "user-1",
      itemId: "item-9",
      tiers: ["QUEUE", "SILENT"],
    });
  });

  it("rejects a garbage / tampered token", () => {
    expect(verifyTierOverrideToken("not-a-jwt")).toBeNull();
    const token = mintTierOverrideToken("user-1", "item-9");
    const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    expect(verifyTierOverrideToken(tampered)).toBeNull();
  });

  it("rejects a session JWT — a session token is NOT a valid override capability", () => {
    // Cryptographic separation: signToken uses the base secret; the override
    // verifier uses a derived secret, so a leaked session token can never be
    // replayed against the override endpoint.
    const sessionToken = signToken({ userId: "user-1", email: "a@b.com" });
    expect(verifyTierOverrideToken(sessionToken)).toBeNull();
  });

  it("rejects a token signed with the wrong/base secret even if shaped right", () => {
    const forged = jwt.sign(
      { kind: "tier-override", userId: "user-1", itemId: "item-9", tiers: ["QUEUE"] },
      BASE_SECRET,
    );
    expect(verifyTierOverrideToken(forged)).toBeNull();
  });

  it("rejects a validly-signed token with the WRONG kind (kind enforced, not just signature)", () => {
    const wrongKind = jwt.sign(
      { kind: "session", userId: "user-1", itemId: "item-9", tiers: ["QUEUE"] },
      OVERRIDE_SECRET,
    );
    expect(verifyTierOverrideToken(wrongKind)).toBeNull();
  });

  it("rejects a validly-signed token missing itemId or tiers", () => {
    const noItem = jwt.sign(
      { kind: "tier-override", userId: "user-1", tiers: ["QUEUE"] },
      OVERRIDE_SECRET,
    );
    expect(verifyTierOverrideToken(noItem)).toBeNull();
    const noTiers = jwt.sign(
      { kind: "tier-override", userId: "user-1", itemId: "item-9" },
      OVERRIDE_SECRET,
    );
    expect(verifyTierOverrideToken(noTiers)).toBeNull();
  });

  it("only ever grants the reversible tiers — never PUSH/AUTO", () => {
    const grant = verifyTierOverrideToken(mintTierOverrideToken("user-1", "item-9"));
    expect(grant?.tiers).not.toContain("PUSH");
    expect(grant?.tiers).not.toContain("AUTO");
  });
});
