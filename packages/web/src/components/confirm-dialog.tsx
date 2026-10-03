"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { getFocusableElements, trapTab } from "../lib/focusable";
import { bodyScrollLock, isPlainEscape, modalStack } from "../lib/modal-stack";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  /**
   * Label for the dismiss button. Defaults to "Cancel", which is ambiguous
   * when the ACTION itself is a cancellation ("Cancel subscription?" with a
   * "Cancel" button reads as if it cancels the subscription) — those callers
   * pass an explicit opposite ("Keep subscription").
   */
  dismissLabel?: string;
  danger?: boolean;
}

interface ConfirmContextType {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextType>({
  confirm: () => Promise.resolve(false),
});

export function useConfirm() {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const confirmTokenRef = useRef<symbol>(Symbol("confirm"));

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    setOptions(opts);
    return new Promise((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const handleClose = (result: boolean) => {
    resolveRef.current?.(result);
    resolveRef.current = null;
    setOptions(null);
  };

  useEffect(() => {
    if (!options) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => {
      getFocusableElements(dialogRef.current)[0]?.focus();
    }, 0);
    const token = confirmTokenRef.current;
    modalStack.push(token);
    const releaseScroll = bodyScrollLock.acquire();
    const handler = (event: KeyboardEvent) => {
      // Only the top overlay in the shared stack owns the keyboard (a Sheet
      // opened over this confirm, or this confirm over a Sheet).
      if (!modalStack.isTop(token)) return;
      if (isPlainEscape(event)) {
        // Stop the event before any modal underneath (e.g. the compose modal,
        // also a window keydown listener) also handles Escape — otherwise one
        // Escape closes both and wipes the compose draft. Paired with the
        // capture-phase registration below so this runs before the
        // underlying modal's bubble-phase listener.
        event.stopImmediatePropagation();
        handleClose(false);
        return;
      }
      trapTab(event, dialogRef.current);
    };
    // Capture phase so this top-most dialog's Escape handler runs BEFORE an
    // underlying modal's bubble-phase window listener (see stopImmediatePropagation).
    window.addEventListener("keydown", handler, true);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handler, true);
      modalStack.remove(token);
      releaseScroll();
      previousFocusRef.current?.focus();
    };
  }, [options]);

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {options && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[130] px-4">
          <div
            ref={dialogRef}
            className="bg-surface-panel border border-line rounded-xl p-6 w-full max-w-sm animate-slide-up"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-message"
          >
            <h3 id="confirm-dialog-title" className="font-semibold mb-2">
              {options.title}
            </h3>
            <p id="confirm-dialog-message" className="text-sm text-ink-mid mb-6">
              {options.message}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => handleClose(false)}
                className="min-h-11 px-4 py-2 rounded-lg text-sm text-ink-mid hover:text-ink transition"
              >
                {options.dismissLabel || "Cancel"}
              </button>
              <button
                type="button"
                onClick={() => handleClose(true)}
                className={`min-h-11 px-4 py-2 rounded-lg text-sm font-medium transition ${
                  options.danger
                    ? "bg-danger-solid hover:bg-danger-solid-hover text-danger-solid-ink"
                    : "bg-accent-solid hover:bg-accent-solid-hover text-accent-solid-ink"
                }`}
              >
                {options.confirmLabel || "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
