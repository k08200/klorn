// Haptics in the Capacitor shell (parity with apps/mobile/src/platform/
// haptics.ts): a light impact when a swipe crosses its threshold, a selection
// tick, success when a Done / send / approval commits, warning when it fails.
// Native only; on the web nothing is loaded. Never throws — feedback, not
// control flow. Each call resolves true once the plugin took it.

import { isNativePlatform } from "./capacitor";

type HapticsModule = typeof import("@capacitor/haptics");
let loaded: Promise<HapticsModule | null> | null = null;

function haptics(): Promise<HapticsModule | null> {
  if (!isNativePlatform()) return Promise.resolve(null);
  loaded ??= import("@capacitor/haptics").catch(() => null);
  return loaded;
}

async function run(fn: (m: HapticsModule) => Promise<void>): Promise<boolean> {
  const m = await haptics();
  if (!m) return false;
  return fn(m).then(
    () => true,
    () => false,
  );
}

export function hapticLight(): Promise<boolean> {
  return run((m) => m.Haptics.impact({ style: m.ImpactStyle.Light }));
}

export function hapticSelection(): Promise<boolean> {
  return run((m) => m.Haptics.selectionChanged());
}

export function hapticSuccess(): Promise<boolean> {
  return run((m) => m.Haptics.notification({ type: m.NotificationType.Success }));
}

export function hapticWarning(): Promise<boolean> {
  return run((m) => m.Haptics.notification({ type: m.NotificationType.Warning }));
}
