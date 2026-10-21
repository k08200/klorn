/**
 * The pairing code of a desktop poll sign-in: the first 40 bits of
 * SHA-256(nonce) in Crockford base32, as XXXX-XXXX. The API shows the same
 * code on the browser's confirmation page (api auth/desktop-confirm.ts); the
 * person signing in checks the two match before confirming. Checked against
 * the API's in api __tests__/web-pairing-code.test.ts.
 */

import { sha256 } from "./sha256";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function pairingCodeOf(nonce: string): string {
  const digest = sha256(new TextEncoder().encode(nonce));
  // 40 bits as 8 groups of 5, most significant first (no BigInt for older webviews).
  let code = "";
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < 5; i++) {
    buffer = (buffer << 8) | (digest[i] ?? 0);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      code += CROCKFORD_BASE32[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
