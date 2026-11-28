// The on-screen keyboard inside the Capacitor shell (parity with
// apps/mobile/src/platform/keyboard.ts). iOS runs Keyboard `resize: "body"`
// (capacitor.config.ts): <body> shrinks, so in-flow content moves, but the
// visual viewport does not — a fixed sheet (the phone reply sheet, the chat
// composer) needs the keyboard height from @capacitor/keyboard's will-show.
// Android `adjustResize` shrinks the WebView itself, so its inset stays 0.
//
// A tiny store the web's useVisualViewport reads; the plugin is loaded only by
// installNativeKeyboard(), which does nothing on the web. It also writes
// `--keyboard-inset` and `html.keyboard-open` for CSS, as the old app did.

import { isNativePlatform, nativePlatform } from "./capacitor";

let inset = 0;
const listeners = new Set<() => void>();

function set(next: number): void {
  if (next === inset) return;
  inset = next;
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.style.setProperty("--keyboard-inset", `${next}px`);
    root.classList.toggle("keyboard-open", next > 0);
  }
  for (const fn of listeners) fn();
}

/** iOS: the px the native keyboard covers while it is up; 0 elsewhere. */
export function nativeKeyboardInset(): number {
  return inset;
}

export function subscribeNativeKeyboard(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Start the native keyboard listeners (shell only). Resolves to the uninstaller. */
export async function installNativeKeyboard(): Promise<() => void> {
  if (!isNativePlatform()) return () => {};
  const ios = nativePlatform() === "ios";
  try {
    const { Keyboard } = await import("@capacitor/keyboard");
    // Android reports a height too, but adjustResize already shrank the page.
    const show = await Keyboard.addListener("keyboardWillShow", (info) =>
      set(ios ? Math.max(0, Math.round(info.keyboardHeight)) : 0),
    );
    const hide = await Keyboard.addListener("keyboardWillHide", () => set(0));
    return () => {
      void show.remove();
      void hide.remove();
      set(0);
    };
  } catch (err) {
    console.warn("[NATIVE] keyboard listeners unavailable:", err);
    return () => {};
  }
}
