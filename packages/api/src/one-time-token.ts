import crypto from "node:crypto";

/**
 * One-time email tokens (password reset, email verification).
 *
 * Only the SHA-256 hash of the token is ever stored — the same standard as
 * Device.tokenHash — so a DB read (backup leak, replica misconfig, SQLi
 * elsewhere) never yields a directly usable reset/verify link. The raw token
 * exists only in the email sent to the user; redemption hashes the presented
 * token and looks the hash up.
 */

export function mintOneTimeToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString("hex");
  return { token, tokenHash: hashOneTimeToken(token) };
}

export function hashOneTimeToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
