/** Open an https link outside the app: the in-app system browser on native, a new tab on web. */
import { isNative } from "./native";

export async function openExternal(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "https:") return; // never javascript:, intent:, file: …
  if (isNative()) {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url: parsed.toString() });
    return;
  }
  window.open(parsed.toString(), "_blank", "noopener,noreferrer");
}
