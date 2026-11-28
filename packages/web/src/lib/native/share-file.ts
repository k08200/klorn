// Attachments inside the Capacitor shell open the OS share sheet (save to
// Files, open in another app) — parity with apps/mobile/src/screens/mail/
// Reader.tsx, which used the WebView's Web Share API with files. Resolves
// false when the shell cannot share files (the caller then downloads as on
// the web), and always false on the plain web, which keeps its download.

import { isNativePlatform } from "./capacitor";

type FileShareNavigator = Navigator & { canShare?: (data: { files: File[] }) => boolean };

export async function shareFileNatively(blob: Blob, filename: string): Promise<boolean> {
  if (!isNativePlatform()) return false;
  const file = new File([blob], filename, { type: blob.type });
  const nav = navigator as FileShareNavigator;
  if (!nav.canShare?.({ files: [file] }) || !nav.share) return false;
  try {
    await nav.share({ files: [file], title: filename });
  } catch (err) {
    // The person closed the sheet: done, not a failure to report.
    if ((err as { name?: string })?.name !== "AbortError") throw err;
  }
  return true;
}
