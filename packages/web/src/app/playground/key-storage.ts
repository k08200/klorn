/**
 * Where a playground visitor's own provider key may live: nowhere, unless they
 * tick "Remember this key on this device".
 *
 * Before 2026-10-30 every keystroke was written to localStorage with no
 * opt-in. Now a key is stored only next to an explicit consent marker, and a
 * key found WITHOUT the marker — one the old page saved on its own — is
 * deleted on load rather than silently reused. Unticking deletes both.
 * lib/logout-cleanup.ts wipes the same keys at sign-out (CASA 6.6.1).
 *
 * Storage is injected so the rules are testable without a DOM; every access
 * is guarded because storage can throw (private mode, blocked site data).
 */

import { PLAYGROUND_PROVIDERS, type PlaygroundProvider } from "./models";

export const PROVIDER_STORAGE = "klorn-playground-provider";
/** The pre-per-provider single slot; only ever deleted now. */
export const LEGACY_KEY_STORAGE = "klorn-playground-key";
/**
 * Provider tabs the playground no longer offers (OpenRouter, retired
 * 2026-11-01). A key a visitor remembered there can no longer be used, so it
 * is deleted on load even with its consent marker.
 */
export const RETIRED_PROVIDER_SLOTS: readonly string[] = ["openrouter"];

export function keyStorageFor(provider: PlaygroundProvider | string): string {
  return `klorn-playground-key-${provider}`;
}

export function rememberMarkerFor(provider: PlaygroundProvider | string): string {
  return `klorn-playground-remember-${provider}`;
}

type KeyStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function safely<T>(fallback: T, run: () => T): T {
  try {
    return run();
  } catch {
    // Blocked or unavailable storage: behave as "nothing remembered".
    return fallback;
  }
}

/** The remembered key, or null. Drops any key stored without consent. */
export function loadRememberedKey(store: KeyStore, provider: PlaygroundProvider): string | null {
  return safely(null, () => {
    store.removeItem(LEGACY_KEY_STORAGE);
    const key = store.getItem(keyStorageFor(provider));
    if (store.getItem(rememberMarkerFor(provider)) === "1" && key) return key;
    store.removeItem(keyStorageFor(provider));
    store.removeItem(rememberMarkerFor(provider));
    return null;
  });
}

/**
 * On page load: delete every provider's key that has no consent marker, and
 * every retired provider's key whatever its marker says.
 */
export function dropUnconsentedKeys(store: KeyStore): void {
  safely(undefined, () => {
    store.removeItem(LEGACY_KEY_STORAGE);
    for (const retired of RETIRED_PROVIDER_SLOTS) {
      store.removeItem(keyStorageFor(retired));
      store.removeItem(rememberMarkerFor(retired));
    }
    for (const provider of PLAYGROUND_PROVIDERS) {
      if (store.getItem(rememberMarkerFor(provider)) === "1") continue;
      store.removeItem(keyStorageFor(provider));
      store.removeItem(rememberMarkerFor(provider));
    }
  });
}

export function rememberKey(store: KeyStore, provider: PlaygroundProvider, key: string): boolean {
  return safely(false, () => {
    if (!key) {
      forgetKey(store, provider);
      return false;
    }
    store.setItem(keyStorageFor(provider), key);
    store.setItem(rememberMarkerFor(provider), "1");
    return true;
  });
}

export function forgetKey(store: KeyStore, provider: PlaygroundProvider): void {
  safely(undefined, () => {
    store.removeItem(keyStorageFor(provider));
    store.removeItem(rememberMarkerFor(provider));
  });
}

export function loadProvider(store: KeyStore): PlaygroundProvider {
  const saved = safely<string | null>(null, () => store.getItem(PROVIDER_STORAGE));
  return saved === "openai" || saved === "gemini" ? saved : "anthropic";
}

export function saveProvider(store: KeyStore, provider: PlaygroundProvider): void {
  safely(undefined, () => store.setItem(PROVIDER_STORAGE, provider));
}
