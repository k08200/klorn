"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

const SHORTCUTS = [
  { keys: ["Cmd", "K"], label: "Command palette" },
  { keys: ["Cmd", "B"], label: "Open briefing" },
  { keys: ["Cmd", "/"], label: "Show shortcuts" },
  { keys: ["Esc"], label: "Close window" },
];

export default function KeyboardShortcuts() {
  const router = useRouter();
  const [showHelp, setShowHelp] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && showHelp) {
        setShowHelp(false);
        return;
      }

      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;

      switch (e.key) {
        case "b":
          e.preventDefault();
          router.push("/briefing");
          break;
        case "/":
          e.preventDefault();
          setShowHelp((prev) => !prev);
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [router, showHelp]);

  useEffect(() => {
    if (!showHelp) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => {
      getFocusableElements(dialogRef.current)[0]?.focus();
    }, 0);
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowHelp(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusableElements(dialogRef.current);
      if (focusable.length === 0) return;
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
    window.addEventListener("keydown", handler);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handler);
      previousFocusRef.current?.focus();
    };
  }, [showHelp]);

  if (!showHelp) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4"
      onClick={() => setShowHelp(false)}
    >
      <div
        ref={dialogRef}
        className="bg-white border border-slate-200 rounded-xl p-6 w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h3 id={titleId} className="font-semibold mb-4">
          Keyboard shortcuts
        </h3>
        <div className="space-y-3">
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="flex items-center justify-between">
              <span className="text-sm text-slate-500">{s.label}</span>
              <div className="flex gap-1">
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    className="bg-slate-50 border border-slate-200 rounded px-2 py-0.5 text-xs text-slate-700 font-mono"
                  >
                    {k}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-500 mt-4 text-center">
          Press Esc or click outside to close.
        </p>
        <button
          type="button"
          onClick={() => setShowHelp(false)}
          className="mt-4 w-full min-h-11 rounded-lg border border-slate-200 text-sm text-slate-500 transition hover:border-sky-500/40 hover:text-sky-600"
        >
          Close
        </button>
      </div>
    </div>
  );
}

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      ["button:not([disabled])", "a[href]", '[tabindex]:not([tabindex="-1"])'].join(","),
    ),
  ).filter((element) => !element.hasAttribute("disabled") && element.offsetParent !== null);
}
