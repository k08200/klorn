/**
 * Encryption at rest for the offline query cache (api/query-client.ts).
 *
 * The cache holds what the last screens showed — senders, subjects, previews,
 * calendar events — in Preferences (UserDefaults / SharedPreferences), which an
 * iOS device backup includes. So it is sealed with AES-256-GCM (WebCrypto) under
 * a random key that lives only in the Keychain / Keystore as a device-only item
 * (secure-store.ts `writeSecret`): a backup, a restored phone or a copied file
 * yields ciphertext without its key, which reads as "no cache". Sign-out deletes
 * the key with the cache, so nothing written before it can be opened again.
 *
 * Fail closed: without WebCrypto, or with a keychain that cannot be read right
 * now, nothing is persisted this session — the cache is a convenience and is
 * never written in the clear.
 *
 * Format: `kc1.<iv base64url>.<ciphertext+tag base64url>`, a fresh 96-bit IV per
 * write. Anything else (the old plaintext cache, a tampered value, the wrong
 * key) opens to null.
 */
import { readSecret, removeSecret, writeSecret } from "./secure-store";

export const CACHE_KEY_SECRET = "klorn-cache-key";
const FORMAT = "kc1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

function subtle(): SubtleCrypto | null {
  return globalThis.crypto?.subtle ?? null;
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function importCacheKey(raw: Uint8Array): Promise<CryptoKey | null> {
  const s = subtle();
  if (!s || raw.length !== KEY_BYTES) return null;
  return s.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealCache(plain: string, key: CryptoKey): Promise<string> {
  const s = subtle();
  if (!s) throw new Error("WebCrypto unavailable");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await s.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return `${FORMAT}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`;
}

export async function openCache(stored: string, key: CryptoKey): Promise<string | null> {
  const s = subtle();
  const parts = stored.split(".");
  if (!s || parts.length !== 3 || parts[0] !== FORMAT) return null;
  const iv = fromBase64Url(parts[1] ?? "");
  const body = fromBase64Url(parts[2] ?? "");
  if (!iv || iv.length !== IV_BYTES || !body) return null;
  try {
    const plain = await s.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      body as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    // Wrong key (a restored backup, a rotated key) or tampered bytes.
    return null;
  }
}

let keyPromise: Promise<CryptoKey | null> | null = null;

async function loadOrCreateKey(): Promise<CryptoKey | null> {
  if (!subtle()) return null;
  // Rejects when the keychain cannot be read now: then persist nothing this
  // session rather than mint a second key over the real one.
  const stored = await readSecret(CACHE_KEY_SECRET);
  const existing = stored ? fromBase64Url(stored) : null;
  if (existing && existing.length === KEY_BYTES) return importCacheKey(existing);
  const raw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  await writeSecret(CACHE_KEY_SECRET, toBase64Url(raw));
  return importCacheKey(raw);
}

/** This device's cache key (created on first use), or null when the cache must not persist. */
export function cacheKey(): Promise<CryptoKey | null> {
  if (!keyPromise) {
    keyPromise = loadOrCreateKey().catch(() => {
      // Let the next session (or the next unlock) try again.
      keyPromise = null;
      return null;
    });
  }
  return keyPromise;
}

/** Sign-out: delete the key, so any cache bytes left behind can never be opened. */
export async function forgetCacheKey(): Promise<void> {
  keyPromise = null;
  await removeSecret(CACHE_KEY_SECRET);
}
