"use client";

/**
 * Renders a modal overlay at the end of <body> (mobile redesign PR5, MB0).
 *
 * The app shell's <main> and the phone header are `relative z-10`: each is a
 * stacking context, and the phone header's backdrop blur also makes it the
 * containing block of a `fixed` child. An overlay drawn inside either one can
 * never rise above the bottom tab bar (z-30) or the assistant button (z-81),
 * whatever its own z-index, and inside the header it is clipped to the
 * header. From <body> its z-index counts against the whole page.
 *
 * Overlays share one layer, z-[120] (as Sheet): above the tab bar (z-30),
 * the assistant (z-80/81) and toasts (z-100). `data-overlay` marks the
 * overlay's root for the e2e z-order checks.
 */

import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Synchronous, so the overlay's own mount effects (focus, focus trap) find
 * their elements. Only for overlays that open on a user action: one that is
 * open on the first render would differ from the server's (empty) render.
 */
export function OverlayPortal({ children }: { children: ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}
