"use client";

/**
 * Sheet (productization plan §2, P2) — a modal panel: right-side on ≥768px,
 * bottom sheet on phones. Elevation L3 (`shadow-l3`) over a 40% scrim,
 * `rounded-sheet`, enter 200ms / exit 160ms on `ease-fluid`. Reduced motion
 * drops the slide and keeps only the opacity change (and the global
 * reduced-motion rule in globals.css shortens that to an instant swap).
 *
 * Accessibility: role="dialog" + aria-modal, labelled by its title and
 * described by `description` when given. Focus moves into the sheet body on
 * open (or `initialFocusRef`), Tab / Shift+Tab are trapped inside (shared
 * lib/focusable trap), Escape and a scrim click close it, and focus returns
 * to the element that opened it. Escape that ends an IME composition is
 * ignored.
 *
 * Stacking: the sheet registers in the shared lib/modal-stack and only the
 * TOP overlay handles Escape / Tab, so a confirm or a second sheet opened over
 * this one owns the keyboard. Body scroll uses the shared ref-counted lock,
 * held until the exit transition finishes.
 */

import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getFocusableElements, trapTab } from "../../lib/focusable";
import { bodyScrollLock, isPlainEscape, modalStack } from "../../lib/modal-stack";
import Button from "./button";

/** Matches --motion-exit; the panel unmounts after the exit transition. */
const EXIT_MS = 160;

type Phase = "closed" | "enter" | "open" | "exit";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** Visible heading; also the dialog's accessible name. */
  title: string;
  description?: string;
  children: ReactNode;
  /** Sticky footer, e.g. the primary/secondary Buttons. */
  footer?: ReactNode;
  /** Element to focus on open; defaults to the first focusable control. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Label for the close button. */
  closeLabel?: string;
}

function CloseGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  initialFocusRef,
  closeLabel = "Close",
}: SheetProps) {
  const [phase, setPhase] = useState<Phase>("closed");
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tokenRef = useRef<symbol>(Symbol("sheet"));
  const openerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // open → enter (offscreen) → open; close → exit → closed after EXIT_MS.
  useEffect(() => {
    if (open) {
      openerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPhase("enter");
      return;
    }
    setPhase((p) => (p === "closed" ? p : "exit"));
    const timer = window.setTimeout(() => setPhase("closed"), EXIT_MS);
    const opener = openerRef.current;
    openerRef.current = null;
    opener?.focus();
    return () => window.clearTimeout(timer);
  }, [open]);

  // Commit the offscreen frame, force a style flush, then slide in so the
  // transition actually runs; move focus once the panel exists.
  useEffect(() => {
    if (phase !== "enter") return;
    const panel = panelRef.current;
    void panel?.offsetHeight;
    setPhase("open");
    const target = initialFocusRef?.current ?? getFocusableElements(bodyRef.current)[0] ?? panel;
    target?.focus();
  }, [phase, initialFocusRef]);

  useEffect(() => {
    if (!open) return;
    const token = tokenRef.current;
    modalStack.push(token);
    const onKeyDown = (event: KeyboardEvent) => {
      // Another overlay is above this one: it owns the keyboard.
      if (!modalStack.isTop(token)) return;
      if (isPlainEscape(event)) {
        // Stop underlying window listeners (e.g. compose modal) from also closing.
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      trapTab(event, panelRef.current);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      modalStack.remove(token);
    };
  }, [open]);

  // Scroll lock spans the whole mounted lifetime, exit transition included.
  const mounted = phase !== "closed";
  useEffect(() => {
    if (!mounted) return;
    return bodyScrollLock.acquire();
  }, [mounted]);

  if (phase === "closed") return null;

  const shown = phase === "open";
  const duration = phase === "exit" ? "duration-160" : "duration-200";

  return createPortal(
    <div className="fixed inset-0 z-[120]">
      <div
        aria-hidden="true"
        onClick={onClose}
        className={`absolute inset-0 bg-black/40 transition-opacity ease-fluid ${duration} ${shown ? "opacity-100" : "opacity-0"}`}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={`absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-sheet border border-line bg-surface-elevated text-ink shadow-l3 outline-none transition-[transform,opacity] ease-fluid md:inset-x-auto md:top-2 md:right-2 md:bottom-2 md:max-h-none md:w-[28rem] md:max-w-[calc(100vw-1rem)] md:rounded-sheet ${duration} ${
          shown
            ? "translate-x-0 translate-y-0 opacity-100"
            : "opacity-0 motion-safe:translate-y-full motion-safe:md:translate-x-full motion-safe:md:translate-y-0"
        }`}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-line-soft py-3 pr-2 pl-5">
          <div className="min-w-0 flex-1 pt-2.5">
            <h2 id={titleId} className="text-title text-ink [word-break:keep-all]">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-1 text-body text-ink-muted [word-break:keep-all]">
                {description}
              </p>
            )}
          </div>
          <Button variant="ghost" size="icon" aria-label={closeLabel} onClick={onClose}>
            <CloseGlyph />
          </Button>
        </div>
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-body">
          {children}
        </div>
        {footer && (
          <div className="flex shrink-0 justify-end gap-2 border-t border-line-soft px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export default Sheet;
