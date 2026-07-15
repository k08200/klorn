/**
 * The ONLY environments where insecure or dev-convenience defaults may engage:
 * the public dev JWT secret, the public dev token-encryption key, the shared
 * demo account, and localhost origin trust.
 *
 * Every such gate must call this — never a bare `NODE_ENV === "production"`
 * (or `!== "production"`) check. That string-equality pattern fails OPEN for
 * any value that isn't the exact literal "production": unset, "staging", a
 * "prod" typo, "Production" — all silently fell into the insecure branch,
 * signing real JWTs / encrypting real secrets with a key that is public in
 * this repo. An explicit allowlist fails CLOSED: anything that isn't
 * development or test is treated as a real deployment.
 */
export function isDevOrTestEnv(): boolean {
  const env = process.env.NODE_ENV;
  return env === "development" || env === "test";
}
