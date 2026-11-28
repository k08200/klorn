// Where the session JWT comes from on launch inside the Capacitor shell, as a
// pure plan (the I/O lives in ./secure-token.ts). Import-free so packages/api
// can test it.
//
// The Keychain/Keystore item is the old mobile app's own (same plugin, same
// "ai.klorn.app_" prefix, same "klorn-token" key — apps/mobile/src/platform/
// secure-store.ts), so an upgrade from that app keeps the person signed in.
// A token a shell build left in localStorage moves into secure storage once.

export interface TokenSources {
  secure: string | null;
  local: string | null;
}

export interface TokenPlan {
  token: string | null;
  /** Copy the token into secure storage (a localStorage-era shell build). */
  writeSecure: boolean;
  /** Remove the localStorage copy (moved, or stale next to the Keychain one). */
  clearLocal: boolean;
}

export function planTokenLoad({ secure, local }: TokenSources): TokenPlan {
  if (secure) return { token: secure, writeSecure: false, clearLocal: Boolean(local) };
  if (local) return { token: local, writeSecure: true, clearLocal: true };
  return { token: null, writeSecure: false, clearLocal: false };
}
