/**
 * The "Later" capability a web push carries: signed for exactly one
 * (user, email), with a purpose-bound secret, so it can never be replayed as a
 * session, as a tier-override token, or for another mail.
 */

import { describe, expect, it } from "vitest";
import { mintTierOverrideToken } from "../billing/tier-override-token.js";
import { mintPushLaterToken, verifyPushLaterToken } from "../notify/push-later-token.js";

describe("push Later token", () => {
  it("round-trips the user and the email it was minted for", () => {
    const token = mintPushLaterToken("user-1", "email-1");
    expect(verifyPushLaterToken(token)).toEqual({ userId: "user-1", emailId: "email-1" });
  });

  it("rejects a tier-override token (a different capability)", () => {
    expect(verifyPushLaterToken(mintTierOverrideToken("user-1", "item-1"))).toBeNull();
  });

  it("rejects a tampered or garbage token", () => {
    const token = mintPushLaterToken("user-1", "email-1");
    const [h, p, s] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), userId: "user-2" }),
    ).toString("base64url");
    expect(verifyPushLaterToken(`${h}.${forged}.${s}`)).toBeNull();
    expect(verifyPushLaterToken("not-a-token")).toBeNull();
    expect(verifyPushLaterToken("")).toBeNull();
  });
});
