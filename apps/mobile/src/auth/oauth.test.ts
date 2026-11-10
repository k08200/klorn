import { describe, expect, it } from "vitest";
import { parseOAuthCallback } from "./oauth";
import { sha256Base64Url } from "./pkce";

describe("OAuth relay deep link", () => {
  const code = "a".repeat(40);
  it("accepts only ai.klorn.app://oauth-callback?code=…", () => {
    expect(parseOAuthCallback(`ai.klorn.app://oauth-callback?code=${code}`)).toBe(code);
    expect(parseOAuthCallback(`klorn://oauth-callback?code=${code}`)).toBeNull();
    expect(parseOAuthCallback(`ai.klorn.app://elsewhere?code=${code}`)).toBeNull();
    expect(parseOAuthCallback("ai.klorn.app://oauth-callback?code=bad code!")).toBeNull();
    expect(parseOAuthCallback("ai.klorn.app://oauth-callback")).toBeNull();
    expect(parseOAuthCallback("not a url")).toBeNull();
  });

  it("PKCE challenge matches the server's S256 base64url", async () => {
    // RFC 7636 appendix B test vector.
    expect(await sha256Base64Url("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});
