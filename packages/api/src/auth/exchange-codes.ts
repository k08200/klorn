import crypto from "node:crypto";

/**
 * In-memory store for OAuth exchange codes (?code in the redirect instead of
 * ?token; expires after 60 s, deleted on first use — prevents JWT leakage via
 * browser history). Module-level rather than an authRoutes closure so every
 * social login callback — Google in routes/auth.ts, Apple/Naver in
 * routes/social-auth.ts — mints codes the single POST /api/auth/exchange-code
 * endpoint can redeem.
 *
 * A web sign-in's code also carries a login binding: the SHA-256 (base64url)
 * of a nonce the browser that started the sign-in keeps to itself
 * (web lib/login-binding.ts). It rides the signed OAuth state, and the code is
 * redeemable only with the nonce. Without it, login CSRF: an attacker who
 * completes their own sign-in hands the victim the callback or the code, and
 * the victim's browser is signed into the attacker's account, where mail the
 * victim then connects is the attacker's to read. Desktop relay codes carry
 * none: the PKCE-bound nonce and the app's own scheme bind those.
 */
export const exchangeCodes = new Map<
  string,
  { jwt: string; expiresAt: number; binding?: string }
>();

const EXCHANGE_CODE_TTL_MS = 60_000;

/** A binding is a SHA-256 digest in unpadded base64url: 43 characters. */
const LOGIN_BINDING = /^[A-Za-z0-9_-]{43}$/;

export function isLoginBinding(value: unknown): value is string {
  return typeof value === "string" && LOGIN_BINDING.test(value);
}

/** Does `nonce` hash to `binding`? Constant-time on the digest. */
export function loginBindingMatches(binding: string, nonce: unknown): boolean {
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 256) return false;
  const actual = crypto.createHash("sha256").update(nonce).digest();
  const expected = Buffer.from(binding, "base64url");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Mint a one-time exchange code for `jwt` and schedule its expiry sweep. */
export function mintExchangeCode(jwt: string, binding?: string): string {
  const code = crypto.randomBytes(20).toString("hex");
  exchangeCodes.set(code, {
    jwt,
    expiresAt: Date.now() + EXCHANGE_CODE_TTL_MS,
    ...(binding ? { binding } : {}),
  });
  const timer = setTimeout(() => exchangeCodes.delete(code), EXCHANGE_CODE_TTL_MS);
  timer.unref?.();
  return code;
}
