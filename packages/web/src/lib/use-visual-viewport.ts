"use client";

import { useEffect, useState } from "react";
import { nativeKeyboardInset, subscribeNativeKeyboard } from "./native/keyboard";

export interface VisualViewportBox {
  /** Pixels the on-screen keyboard (or other UI) covers at the bottom of the layout viewport. */
  bottomInset: number;
  /** Height of what the user can actually see. */
  height: number;
}

/**
 * The visible part of the page while the on-screen keyboard is up. The app's
 * viewport meta keeps the default `interactive-widget` (resizes-visual), so on
 * iOS Safari and Android Chrome the keyboard shrinks only the visual viewport:
 * a `position: fixed; bottom: 0` panel would sit under the keyboard. A panel
 * that must stay in reach (the phone reply sheet's Send) uses `bottomInset`
 * as its bottom offset and `height` to cap its own height. Null until mounted
 * or where `window.visualViewport` is missing (then CSS alone places it).
 */
export function useVisualViewport(active: boolean): VisualViewportBox | null {
  const [box, setBox] = useState<VisualViewportBox | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!active || !viewport) {
      setBox(null);
      return;
    }
    const update = () => {
      const viewportInset = Math.max(
        0,
        Math.round(window.innerHeight - (viewport.height + viewport.offsetTop)),
      );
      // The Capacitor shell on iOS (Keyboard resize "body") shrinks <body>,
      // not the visual viewport: the native keyboard height is the inset there.
      // Always 0 on the web (native/keyboard.ts).
      const keyboard = nativeKeyboardInset();
      const bottomInset = Math.max(viewportInset, keyboard);
      const height = keyboard > viewportInset ? window.innerHeight - keyboard : viewport.height;
      setBox({ bottomInset, height: Math.round(height) });
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    const unsubscribeNative = subscribeNativeKeyboard(update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      unsubscribeNative();
    };
  }, [active]);
  return box;
}
