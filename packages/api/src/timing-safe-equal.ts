import crypto from "node:crypto";

/**
 * Constant-time string comparison for secrets (shared bearer tokens, webhook
 * signatures). Both inputs are hashed to fixed 32-byte buffers first, so
 * timingSafeEqual never throws on a length mismatch and the secret's length is
 * not itself a timing side channel. Use this instead of `===` anywhere an
 * attacker-supplied value is compared against a server-side secret.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
