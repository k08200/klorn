/**
 * Single source of truth for "may a public, hardcoded dev-fallback secret back
 * a real cryptographic operation here?" — used by both the JWT signing key
 * (auth.ts) and the token-encryption key (crypto-tokens.ts).
 *
 * ONLY local development/test may use the fallbacks (both are values published
 * in this repo). Any other NODE_ENV — production, staging, an unset value, a
 * "prod" typo, or a self-host container image that never sets NODE_ENV — MUST
 * supply a real secret; otherwise the process must fail to boot. This is an
 * explicit allowlist rather than a `!== "production"` check, so an unexpected
 * environment fails closed instead of silently signing/encrypting with a
 * guessable key (ASVS V6.4 / V14.1: no default/hardcoded secrets, fail secure).
 */
export function isDevFallbackSecretAllowed(nodeEnv = process.env.NODE_ENV): boolean {
  return nodeEnv === "development" || nodeEnv === "test";
}
