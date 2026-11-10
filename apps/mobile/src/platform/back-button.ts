/**
 * Android hardware/gesture back → the router's back decision. With any
 * listener registered Capacitor no longer navigates the WebView itself, so
 * the app owns back completely. At the root it backgrounds the app (Android
 * convention) rather than killing it.
 */
import { App } from "@capacitor/app";
import type { BackAction } from "../router/back";
import { platformName } from "./native";

export function installBackButton(back: () => BackAction): () => void {
  if (platformName() !== "android") return () => {};
  const handle = App.addListener("backButton", () => {
    const action = back();
    if (action.kind === "exit") void App.minimizeApp();
  });
  return () => {
    void handle.then((h) => h.remove());
  };
}
