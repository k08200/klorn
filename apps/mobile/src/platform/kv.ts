/**
 * Non-secret key/value storage: the offline query cache and UI preferences
 * (locale and theme overrides). Native → @capacitor/preferences (app-sandboxed
 * UserDefaults / SharedPreferences); browser → localStorage. Secrets (the
 * session JWT) never go here — see secure-store.ts.
 */
import { Preferences } from "@capacitor/preferences";
import { isNative } from "./native";

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const nativeStore: KeyValueStore = {
  async getItem(key) {
    const { value } = await Preferences.get({ key });
    return value;
  },
  async setItem(key, value) {
    await Preferences.set({ key, value });
  },
  async removeItem(key) {
    await Preferences.remove({ key });
  },
};

const webStore: KeyValueStore = {
  async getItem(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  async setItem(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Quota or privacy mode — the cache is a convenience, never required.
    }
  },
  async removeItem(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

export const kv: KeyValueStore = {
  getItem: (key) => (isNative() ? nativeStore : webStore).getItem(key),
  setItem: (key, value) => (isNative() ? nativeStore : webStore).setItem(key, value),
  removeItem: (key) => (isNative() ? nativeStore : webStore).removeItem(key),
};
