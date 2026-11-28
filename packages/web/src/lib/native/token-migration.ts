// Where the session JWT comes from on launch inside the Capacitor shell, as a
// pure plan (the I/O lives in ./secure-token.ts). Import-free so packages/api
// can test it.
//
// The Keychain/Keystore item is the old mobile app's own (same plugin, same
// "ai.klorn.app_" prefix, same "klorn-token" key — apps/mobile/src/platform/
// secure-store.ts), so an upgrade from that app keeps the person signed in.
//
// A localStorage token is always the newest one: in the shell it is written
// only by a build from before secure storage, or as the fallback when a
// Keychain write failed (lib/api.ts). It wins and moves into the Keychain.
// `cleared` marks a sign-out whose Keychain clear failed: the item is removed
// before anything is read, so the session does not come back.

export interface TokenSources {
  secure: string | null;
  local: string | null;
  cleared: boolean;
}

export interface TokenPlan {
  token: string | null;
  /** Copy the token into secure storage. */
  writeSecure: boolean;
  /** Remove the Keychain item (a sign-out that did not reach it). */
  clearSecure: boolean;
  /** Remove the localStorage copy once it is safe in the Keychain. */
  clearLocal: boolean;
}

const NONE: TokenPlan = { token: null, writeSecure: false, clearSecure: false, clearLocal: false };

export function planTokenLoad({ secure, local, cleared }: TokenSources): TokenPlan {
  if (local) return { token: local, writeSecure: true, clearSecure: false, clearLocal: true };
  if (cleared) return { ...NONE, clearSecure: Boolean(secure) };
  if (secure) return { ...NONE, token: secure };
  return NONE;
}
