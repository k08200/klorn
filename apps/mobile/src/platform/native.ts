import { Capacitor } from "@capacitor/core";

/** True inside the Capacitor iOS / Android shell; false in a browser. */
export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

export type PlatformName = "ios" | "android" | "web";

export function platformName(): PlatformName {
  const p = Capacitor.getPlatform();
  return p === "ios" || p === "android" ? p : "web";
}

/** Whether a native plugin is actually present in this build. */
export function hasPlugin(name: string): boolean {
  return Capacitor.isPluginAvailable(name);
}
