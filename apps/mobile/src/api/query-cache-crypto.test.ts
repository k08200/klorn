import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-ins for Preferences (kv) and the Keychain (secure-store).
const prefs = vi.hoisted(() => new Map<string, string>());
const secrets = vi.hoisted(() => new Map<string, string>());
const keychainLocked = vi.hoisted(() => ({ value: false }));

vi.mock("../platform/kv", () => ({
  kv: {
    getItem: async (k: string) => prefs.get(k) ?? null,
    setItem: async (k: string, v: string) => void prefs.set(k, v),
    removeItem: async (k: string) => void prefs.delete(k),
  },
}));
vi.mock("../platform/secure-store", () => ({
  readSecret: async (k: string) => {
    if (keychainLocked.value) throw new Error("keychain locked");
    return secrets.get(k) ?? null;
  },
  writeSecret: async (k: string, v: string) => void secrets.set(k, v),
  removeSecret: async (k: string) => void secrets.delete(k),
}));

const crypto = await import("../platform/cache-crypto");
const { CACHE_KEY, LEGACY_CACHE_KEY, clearPersistedCache, encryptedCacheStore } = await import(
  "./query-client"
);

const SAMPLE = JSON.stringify({ queryKey: ["mail", "firewall"], subject: "계약서 수정본" });

beforeEach(async () => {
  prefs.clear();
  secrets.clear();
  keychainLocked.value = false;
  await crypto.forgetCacheKey();
});

describe("offline cache encryption", () => {
  it("never writes the cache in the clear, and reads it back", async () => {
    await encryptedCacheStore.setItem(CACHE_KEY, SAMPLE);
    const stored = prefs.get(CACHE_KEY) ?? "";
    expect(stored.startsWith("kc1.")).toBe(true);
    expect(stored).not.toContain("firewall");
    expect(stored).not.toContain("계약서");
    expect(await encryptedCacheStore.getItem(CACHE_KEY)).toBe(SAMPLE);
  });

  it("uses a fresh IV per write", async () => {
    await encryptedCacheStore.setItem(CACHE_KEY, SAMPLE);
    const first = prefs.get(CACHE_KEY);
    await encryptedCacheStore.setItem(CACHE_KEY, SAMPLE);
    expect(prefs.get(CACHE_KEY)).not.toBe(first);
  });

  it("keeps one key across reads (created once, device-only secret)", async () => {
    await encryptedCacheStore.setItem(CACHE_KEY, SAMPLE);
    const key = secrets.get(crypto.CACHE_KEY_SECRET);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await encryptedCacheStore.setItem(CACHE_KEY, SAMPLE);
    expect(secrets.get(crypto.CACHE_KEY_SECRET)).toBe(key);
  });

  it("a cache without its key (restored backup) reads as empty and is removed", async () => {
    await encryptedCacheStore.setItem(CACHE_KEY, SAMPLE);
    // A backup restore brings the Preferences file but not the device-only key.
    secrets.clear();
    await crypto.forgetCacheKey();
    expect(await encryptedCacheStore.getItem(CACHE_KEY)).toBeNull();
    expect(prefs.has(CACHE_KEY)).toBe(false);
  });

  it("tampered bytes and the old plaintext format open to null", async () => {
    const key = await crypto.importCacheKey(new Uint8Array(32).fill(7));
    if (!key) throw new Error("no key");
    const sealed = await crypto.sealCache(SAMPLE, key);
    const [f, iv, body] = sealed.split(".");
    const flipped = `${body?.[0] === "A" ? "B" : "A"}${body?.slice(1)}`;
    expect(await crypto.openCache(`${f}.${iv}.${flipped}`, key)).toBeNull();
    expect(await crypto.openCache(SAMPLE, key)).toBeNull();
    expect(await crypto.openCache("kc1.!!.??", key)).toBeNull();
    const other = await crypto.importCacheKey(new Uint8Array(32).fill(8));
    if (!other) throw new Error("no key");
    expect(await crypto.openCache(sealed, other)).toBeNull();
    expect(await crypto.openCache(sealed, key)).toBe(SAMPLE);
  });

  it("drops the legacy plaintext cache on first read", async () => {
    prefs.set(LEGACY_CACHE_KEY, SAMPLE);
    await encryptedCacheStore.getItem(CACHE_KEY);
    expect(prefs.has(LEGACY_CACHE_KEY)).toBe(false);
  });

  it("fails closed: an unreadable keychain persists nothing and mints no second key", async () => {
    keychainLocked.value = true;
    await encryptedCacheStore.setItem(CACHE_KEY, SAMPLE);
    expect(prefs.has(CACHE_KEY)).toBe(false);
    expect(secrets.size).toBe(0);
  });

  it("sign-out deletes the cache and its key, so leftovers can never be opened", async () => {
    await encryptedCacheStore.setItem(CACHE_KEY, SAMPLE);
    const leftover = prefs.get(CACHE_KEY) ?? "";
    prefs.set(LEGACY_CACHE_KEY, SAMPLE);
    await clearPersistedCache();
    expect(prefs.size).toBe(0);
    expect(secrets.size).toBe(0);
    // Even if a copy of the bytes survived somewhere, the next key cannot open it.
    prefs.set(CACHE_KEY, leftover);
    expect(await encryptedCacheStore.getItem(CACHE_KEY)).toBeNull();
  });

  it("base64url round-trips and rejects foreign characters", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    const text = crypto.toBase64Url(bytes);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Array.from(crypto.fromBase64Url(text) ?? [])).toEqual(Array.from(bytes));
    expect(crypto.fromBase64Url("a+b/")).toBeNull();
  });
});
