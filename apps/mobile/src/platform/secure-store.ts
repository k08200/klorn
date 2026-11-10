/**
 * Where the session JWT lives. Native → the iOS Keychain / Android Keystore
 * via @aparajita/capacitor-secure-storage, never localStorage or Preferences.
 * Browser (dev and tests only) → localStorage, which is what the web app does.
 */
import { KeychainAccess, SecureStorage } from "@aparajita/capacitor-secure-storage";
import { isNative } from "./native";

const TOKEN_KEY = "klorn-token";
let prefixed = false;

async function ensurePrefix(): Promise<void> {
  if (prefixed) return;
  // Not iCloud-synchronised: a session belongs to this device only.
  await SecureStorage.setSynchronize(false);
  await SecureStorage.setKeyPrefix("ai.klorn.app_");
  prefixed = true;
}

export async function readToken(): Promise<string | null> {
  if (!isNative()) {
    try {
      return window.localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }
  await ensurePrefix();
  try {
    const value = await SecureStorage.getItem(TOKEN_KEY);
    return typeof value === "string" && value ? value : null;
  } catch {
    // A corrupt or unreadable item means "signed out", not a crash.
    return null;
  }
}

export async function writeToken(token: string): Promise<void> {
  if (!isNative()) {
    window.localStorage.setItem(TOKEN_KEY, token);
    return;
  }
  await ensurePrefix();
  await SecureStorage.setItem(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  if (!isNative()) {
    try {
      window.localStorage.removeItem(TOKEN_KEY);
    } catch {
      // ignore
    }
    return;
  }
  await ensurePrefix();
  await SecureStorage.removeItem(TOKEN_KEY).catch(() => {});
}

/**
 * Other device-only secrets (the offline cache key, platform/cache-crypto.ts).
 * iOS: `afterFirstUnlockThisDeviceOnly` — never in an iCloud or iTunes backup,
 * never moved to a new phone, readable once the device has been unlocked after
 * boot. Android: the Keystore, which is not backed up either. Browser (dev and
 * tests only): localStorage.
 *
 * `readSecret` resolves null only when the item does not exist; an unreadable
 * keychain REJECTS, so a caller can tell "no key yet" from "can't read it now".
 */
export async function readSecret(key: string): Promise<string | null> {
  if (!isNative()) return window.localStorage.getItem(key);
  await ensurePrefix();
  const value = await SecureStorage.get(key, false);
  return typeof value === "string" && value ? value : null;
}

export async function writeSecret(key: string, value: string): Promise<void> {
  if (!isNative()) {
    window.localStorage.setItem(key, value);
    return;
  }
  await ensurePrefix();
  await SecureStorage.set(key, value, false, false, KeychainAccess.afterFirstUnlockThisDeviceOnly);
}

export async function removeSecret(key: string): Promise<void> {
  if (!isNative()) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // ignore
    }
    return;
  }
  await ensurePrefix();
  await SecureStorage.remove(key).catch(() => false);
}
