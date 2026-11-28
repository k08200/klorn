// The session JWT inside the Capacitor shell lives in the iOS Keychain /
// Android Keystore (@aparajita/capacitor-secure-storage), never in
// localStorage — parity with apps/mobile/src/platform/secure-store.ts, whose
// item (prefix "ai.klorn.app_", key "klorn-token", not iCloud-synchronised)
// this reads, so people upgrading from that app stay signed in. Loaded only
// from lib/api.ts when Capacitor reports a native platform; the plain web
// never imports this file.

import { planTokenLoad } from "./token-migration";

const KEY_PREFIX = "ai.klorn.app_";
const TOKEN_KEY = "klorn-token";

type SecureStorageModule = typeof import("@aparajita/capacitor-secure-storage");
let ready: Promise<SecureStorageModule["SecureStorage"]> | null = null;

function storage(): Promise<SecureStorageModule["SecureStorage"]> {
  ready ??= import("@aparajita/capacitor-secure-storage").then(async ({ SecureStorage }) => {
    // A session belongs to this device only.
    await SecureStorage.setSynchronize(false);
    await SecureStorage.setKeyPrefix(KEY_PREFIX);
    return SecureStorage;
  });
  return ready;
}

/**
 * The token to start with. `local` is what localStorage holds (a shell build
 * from before this module); `clearLocal` removes it once it is safe in the
 * Keychain. Rejects when secure storage is unusable — the caller then keeps
 * the localStorage behaviour rather than signing anyone out.
 */
export async function loadSecureToken(
  local: string | null,
  clearLocal: () => void,
): Promise<string | null> {
  const secureStorage = await storage();
  const raw = await secureStorage.getItem(TOKEN_KEY);
  const plan = planTokenLoad({ secure: typeof raw === "string" ? raw : null, local });
  if (plan.writeSecure && plan.token) await secureStorage.setItem(TOKEN_KEY, plan.token);
  if (plan.clearLocal) clearLocal();
  return plan.token;
}

export async function writeSecureToken(token: string): Promise<void> {
  await (await storage()).setItem(TOKEN_KEY, token);
}

export async function clearSecureToken(): Promise<void> {
  await (await storage()).removeItem(TOKEN_KEY);
}
