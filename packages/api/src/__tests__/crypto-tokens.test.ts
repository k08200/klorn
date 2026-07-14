import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");
const LEGACY_KEY = Buffer.alloc(32, 9).toString("base64");

async function loadFresh() {
  vi.resetModules();
  return import("../crypto-tokens.js");
}

const ORIGINAL_ENV = { ...process.env };

function clearCryptoEnv() {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.TOKEN_ENCRYPTION_KEY;
  delete process.env.TOKEN_ENCRYPTION_KEYS;
  delete process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID;
  process.env.NODE_ENV = "test";
}

describe("crypto-tokens — legacy v1 (no keyring configured)", () => {
  beforeEach(clearCryptoEnv);
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("round-trips and still emits v1 when only the single legacy key is set", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = LEGACY_KEY;
    const { encryptToken, decryptToken } = await loadFresh();
    const plain = "ya29.fake-google-access-token-abc123";
    const ct = encryptToken(plain);
    expect(ct.startsWith("v1:")).toBe(true);
    expect(ct).not.toContain(plain);
    expect(decryptToken(ct)).toBe(plain);
  });

  it("uses a fresh IV per call", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = LEGACY_KEY;
    const { encryptToken, decryptToken } = await loadFresh();
    const a = encryptToken("same-value");
    const b = encryptToken("same-value");
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe("same-value");
    expect(decryptToken(b)).toBe("same-value");
  });

  it("refuses a non-v1/v2 (plaintext) token instead of silently trusting it", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = LEGACY_KEY;
    const { decryptToken } = await loadFresh();
    expect(() => decryptToken("already-stored-plaintext-token")).toThrow(/non-v1/i);
  });

  it("rejects tampered ciphertext via the GCM auth tag", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = LEGACY_KEY;
    const { encryptToken, decryptToken } = await loadFresh();
    const ct = encryptToken("secret");
    expect(() => decryptToken(`${ct.slice(0, -4)}AAAA`)).toThrow();
  });

  it("throws on malformed v1 envelopes and preserves empty/null semantics", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = LEGACY_KEY;
    const { decryptToken, encryptToken, encryptOptional, decryptOptional } = await loadFresh();
    expect(() => decryptToken("v1:not-enough-parts")).toThrow(/malformed/i);
    expect(encryptToken("")).toBe("");
    expect(decryptToken("")).toBe("");
    expect(encryptOptional(null)).toBeNull();
    expect(decryptOptional(undefined)).toBeNull();
  });
});

describe("crypto-tokens — keyring v2 (rotation)", () => {
  beforeEach(clearCryptoEnv);
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("emits v2:<activeKeyId> when a keyring + active id are configured", async () => {
    process.env.TOKEN_ENCRYPTION_KEYS = JSON.stringify({ ka: KEY_A, kb: KEY_B });
    process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID = "kb";
    const { encryptToken, decryptToken } = await loadFresh();
    const ct = encryptToken("refresh-token");
    expect(ct.startsWith("v2:kb:")).toBe(true);
    expect(decryptToken(ct)).toBe("refresh-token");
  });

  it("decrypts a v2 token minted under a now-non-active key (rotation window)", async () => {
    // Encrypt under ka…
    process.env.TOKEN_ENCRYPTION_KEYS = JSON.stringify({ ka: KEY_A });
    process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID = "ka";
    const first = await loadFresh();
    const underA = first.encryptToken("port-me");
    expect(underA.startsWith("v2:ka:")).toBe(true);

    // …then rotate: kb is active but ka is still in the ring for reads.
    process.env.TOKEN_ENCRYPTION_KEYS = JSON.stringify({ ka: KEY_A, kb: KEY_B });
    process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID = "kb";
    const second = await loadFresh();
    expect(second.decryptToken(underA)).toBe("port-me");
    expect(second.encryptToken("new").startsWith("v2:kb:")).toBe(true);
  });

  it("still reads legacy v1 rows when the legacy key is kept alongside the keyring", async () => {
    // v1 written by the old deploy…
    process.env.TOKEN_ENCRYPTION_KEY = LEGACY_KEY;
    const legacy = await loadFresh();
    const v1 = legacy.encryptToken("old-oauth-token");
    expect(v1.startsWith("v1:")).toBe(true);

    // …keyring added, legacy key retained → v1 still decrypts, new writes are v2.
    process.env.TOKEN_ENCRYPTION_KEYS = JSON.stringify({ kb: KEY_B });
    process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID = "kb";
    const rotated = await loadFresh();
    expect(rotated.decryptToken(v1)).toBe("old-oauth-token");
    expect(rotated.encryptToken("x").startsWith("v2:kb:")).toBe(true);
  });

  it("throws for a v2 token whose key id is not in the ring (retired key)", async () => {
    process.env.TOKEN_ENCRYPTION_KEYS = JSON.stringify({ ka: KEY_A });
    process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID = "ka";
    const app = await loadFresh();
    const ct = app.encryptToken("v");
    const forged = ct.replace("v2:ka:", "v2:zz:");
    expect(() => app.decryptToken(forged)).toThrow(/unknown key id/i);
  });

  it("fails fast at load when the active key id is missing from the ring", async () => {
    process.env.TOKEN_ENCRYPTION_KEYS = JSON.stringify({ ka: KEY_A });
    process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID = "kb"; // not present
    await expect(loadFresh()).rejects.toThrow(/ACTIVE_KEY_ID.*not present/i);
  });

  it("rejects a keyring whose key does not decode to 32 bytes", async () => {
    process.env.TOKEN_ENCRYPTION_KEYS = JSON.stringify({
      ka: Buffer.alloc(16, 1).toString("base64"),
    });
    process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID = "ka";
    await expect(loadFresh()).rejects.toThrow(/32 bytes/i);
  });

  it("rejects a key id containing the ':' envelope delimiter", async () => {
    process.env.TOKEN_ENCRYPTION_KEYS = JSON.stringify({ "bad:id": KEY_A });
    process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID = "bad:id";
    await expect(loadFresh()).rejects.toThrow(/key id/i);
  });

  it("needsReencryption flags v1 and stale-v2 tokens, not active-key v2", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = LEGACY_KEY;
    const legacy = await loadFresh();
    const v1 = legacy.encryptToken("t");

    process.env.TOKEN_ENCRYPTION_KEYS = JSON.stringify({ ka: KEY_A, kb: KEY_B });
    process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID = "kb";
    const rotated = await loadFresh();
    // v1 (legacy) and v2 under the non-active ka both need rewriting.
    const underKa = `v2:ka:${rotated.encryptToken("t").split(":").slice(2).join(":")}`;
    expect(rotated.needsReencryption(v1)).toBe(true);
    expect(rotated.needsReencryption(underKa)).toBe(true);
    // A token already at v2 under the active key is up to date.
    expect(rotated.needsReencryption(rotated.encryptToken("t"))).toBe(false);
    expect(rotated.needsReencryption(null)).toBe(false);
  });

  it("reencryptToActiveKey rewrites a v1 token to v2 under the active key, same plaintext", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = LEGACY_KEY;
    const legacy = await loadFresh();
    const v1 = legacy.encryptToken("rotate-me");

    process.env.TOKEN_ENCRYPTION_KEYS = JSON.stringify({ kb: KEY_B });
    process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID = "kb";
    const rotated = await loadFresh();
    const v2 = rotated.reencryptToActiveKey(v1);
    expect(v2?.startsWith("v2:kb:")).toBe(true);
    expect(rotated.decryptToken(v2 as string)).toBe("rotate-me");
  });
});
