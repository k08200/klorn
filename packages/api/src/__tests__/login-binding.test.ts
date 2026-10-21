import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  exchangeCodes,
  isLoginBinding,
  loginBindingMatches,
  mintExchangeCode,
} from "../auth/exchange-codes.js";

// Login CSRF: an attacker who completes their own sign-in can hand the victim
// the callback (or the exchange code) and log the victim's browser into the
// attacker's account; mail the victim then connects lands with the attacker.
// A web sign-in now carries the hash of a nonce only the starting browser
// holds, and its exchange code is redeemable only with that nonce.

const nonce = crypto.randomBytes(32).toString("base64url");
const bindingOf = (value: string) => crypto.createHash("sha256").update(value).digest("base64url");

describe("login binding", () => {
  it("accepts only a SHA-256 in base64url as a binding", () => {
    expect(isLoginBinding(bindingOf(nonce))).toBe(true);
    expect(isLoginBinding(undefined)).toBe(false);
    expect(isLoginBinding("short")).toBe(false);
    expect(isLoginBinding(`${bindingOf(nonce).slice(0, 42)}=`)).toBe(false);
  });

  it("matches the nonce whose hash it is, and nothing else", () => {
    const binding = bindingOf(nonce);
    expect(loginBindingMatches(binding, nonce)).toBe(true);
    expect(loginBindingMatches(binding, `${nonce}x`)).toBe(false);
    expect(loginBindingMatches(binding, undefined)).toBe(false);
    expect(loginBindingMatches(binding, "")).toBe(false);
  });

  it("stores the binding with the code it was minted for", () => {
    const binding = bindingOf(nonce);
    const code = mintExchangeCode("jwt-1", binding);
    expect(exchangeCodes.get(code)).toMatchObject({ jwt: "jwt-1", binding });
    const unbound = mintExchangeCode("jwt-2");
    expect(exchangeCodes.get(unbound)?.binding).toBeUndefined();
  });
});
