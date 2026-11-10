/**
 * SHA-256 in plain JavaScript, for the login binding (lib/login-binding.ts)
 * where `crypto.subtle` is missing: it exists only in secure contexts, and a
 * self-hosted instance served over plain http on a LAN address is not one.
 * Checked against Node's crypto (api __tests__/web-sha256.test.ts).
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** The SHA-256 digest of `message`. */
export function sha256(message: Uint8Array): Uint8Array {
  const bitLength = message.length * 8;
  // Message, 0x80, zeros, then the 64-bit big-endian length: a multiple of 64 bytes.
  const padded = new Uint8Array(Math.ceil((message.length + 9) / 64) * 64);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] ?? 0;
      const w2 = w[i - 2] ?? 0;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let a = h[0] ?? 0;
    let b = h[1] ?? 0;
    let c = h[2] ?? 0;
    let d = h[3] ?? 0;
    let e = h[4] ?? 0;
    let f = h[5] ?? 0;
    let g = h[6] ?? 0;
    let hh = h[7] ?? 0;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = ((h[0] ?? 0) + a) >>> 0;
    h[1] = ((h[1] ?? 0) + b) >>> 0;
    h[2] = ((h[2] ?? 0) + c) >>> 0;
    h[3] = ((h[3] ?? 0) + d) >>> 0;
    h[4] = ((h[4] ?? 0) + e) >>> 0;
    h[5] = ((h[5] ?? 0) + f) >>> 0;
    h[6] = ((h[6] ?? 0) + g) >>> 0;
    h[7] = ((h[7] ?? 0) + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i] ?? 0);
  return out;
}
