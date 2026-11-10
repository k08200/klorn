/**
 * Haptics (canvas notes.gestures): a light impact when a swipe crosses its
 * threshold, a selection tick when multi-select starts, success when a
 * Done / send commits. Native only (@capacitor/haptics); the browser stays
 * silent. Never throws — haptics are feedback, not control flow.
 */
import { hasPlugin, isNative } from "./native";

type HapticsModule = typeof import("@capacitor/haptics");
let loaded: Promise<HapticsModule | null> | null = null;

function haptics(): Promise<HapticsModule | null> {
  if (!isNative() || !hasPlugin("Haptics")) return Promise.resolve(null);
  loaded ??= import("@capacitor/haptics").catch(() => null);
  return loaded;
}

export function hapticLight(): void {
  void haptics().then((m) => m?.Haptics.impact({ style: m.ImpactStyle.Light }).catch(() => {}));
}

export function hapticSelection(): void {
  void haptics().then((m) => m?.Haptics.selectionChanged().catch(() => {}));
}

export function hapticSuccess(): void {
  void haptics().then((m) =>
    m?.Haptics.notification({ type: m.NotificationType.Success }).catch(() => {}),
  );
}

export function hapticWarning(): void {
  void haptics().then((m) =>
    m?.Haptics.notification({ type: m.NotificationType.Warning }).catch(() => {}),
  );
}
