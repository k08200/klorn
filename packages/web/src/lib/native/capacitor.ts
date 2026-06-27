// Capacitor runtime detection — safe during SSR and on the plain web build.
//
// Capacitor injects `window.Capacitor` only inside the native shell
// (apps/mobile). On the web it is absent, so every native code path that gates
// on these helpers is a no-op and the deployed site behaves exactly as before.
// Detection reads the injected global directly, so this module imports nothing
// from @capacitor/* and never touches `window` at import time.

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function cap(): CapacitorGlobal | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/** True only inside the native iOS/Android shell. */
export function isNativePlatform(): boolean {
  return cap()?.isNativePlatform?.() ?? false;
}

/** The native platform, or null on the web. */
export function nativePlatform(): "ios" | "android" | null {
  const p = cap()?.getPlatform?.();
  return p === "ios" || p === "android" ? p : null;
}
