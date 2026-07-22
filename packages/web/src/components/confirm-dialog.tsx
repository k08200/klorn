"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
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
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // This confirm is the TOP-most modal. Stop the event before any modal
        // underneath (e.g. the compose modal, also a window keydown listener)
        // also handles Escape — otherwise one Escape closes both and wipes the
        // compose draft. Paired with the capture-phase registration below so
        // this runs before the underlying modal's bubble-phase listener.
        event.stopImmediatePropagation();
        handleClose(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusableElements(dialogRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    // Capture phase so this top-most dialog's Escape handler runs BEFORE an
    // underlying modal's bubble-phase window listener (see stopImmediatePropagation).
    window.addEventListener("keydown", handler, true);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handler, true);
      previousFocusRef.current?.focus();
    };
  }, [options]);

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {options && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[110] px-4">
          <div
            ref={dialogRef}
            className="bg-white border border-slate-200 rounded-xl p-6 w-full max-w-sm animate-slide-up"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-message"
          >
            <h3 id="confirm-dialog-title" className="font-semibold mb-2">
              {options.title}
            </h3>
            <p id="confirm-dialog-message" className="text-sm text-slate-500 mb-6">
              {options.message}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => handleClose(false)}
                className="min-h-11 px-4 py-2 rounded-lg text-sm text-slate-500 hover:text-slate-900 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleClose(true)}
                className={`min-h-11 px-4 py-2 rounded-lg text-sm font-medium transition ${
                  options.danger
                    ? "bg-red-600 hover:bg-red-500 text-white"
                    : "bg-sky-500 hover:bg-sky-600 text-white"
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

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      [
        "a[href]",
        "button:not([disabled])",
        "textarea:not([disabled])",
        "input:not([disabled])",
        "select:not([disabled])",
        '[tabindex]:not([tabindex="-1"])',
      ].join(","),
    ),
  ).filter((element) => !element.hasAttribute("disabled") && element.offsetParent !== null);
}
