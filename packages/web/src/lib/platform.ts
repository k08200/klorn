import { useSyncExternalStore } from "react";

/**
 * True on macOS / iOS, where the shortcut modifier is ⌘; everywhere else
 * (Windows — including the WebView2 desktop shell — Linux, Android) it is Ctrl.
 * userAgentData is the non-deprecated source where it exists (Chromium);
 * navigator.platform covers Safari and Firefox.
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData?.platform;
  return /Mac|iPhone|iPad|iOS/i.test(uaPlatform || navigator.platform || "");
}

const noopSubscribe = () => () => {};

/**
 * isApplePlatform() for render. The server snapshot is `true` (⌘, the prior
 * hard-coded hint), and React swaps in the client value right after
 * hydration, so markup never mismatches.
 */
export function useIsApplePlatform(): boolean {
  return useSyncExternalStore(noopSubscribe, isApplePlatform, () => true);
}

/** Display label of the shortcut modifier: "⌘" on Apple platforms, "Ctrl" elsewhere. */
export function modKeyLabel(isApple: boolean): string {
  return isApple ? "⌘" : "Ctrl";
}
