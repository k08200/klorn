"use client";

import { useEffect, useState } from "react";

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
      const bottomInset = Math.max(
        0,
        Math.round(window.innerHeight - (viewport.height + viewport.offsetTop)),
      );
      setBox({ bottomInset, height: Math.round(viewport.height) });
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [active]);
  return box;
}
