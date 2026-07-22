"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Matches the API contract: PendingAction reject accepts an optional reason
// of at most 500 characters (chat-pending-actions.ts rejectActionBodySchema).
export const MAX_REJECT_REASON_LENGTH = 500;

interface RejectReasonDialogProps {
  open: boolean;
  onCancel: () => void;
  /** Called with the trimmed reason, or null when the user skips it. */
  onReject: (reason: string | null) => void;
}

/**
 * Small modal asking why a suggestion is being rejected. The reason is
 * optional — "Skip & Reject" and an empty "Reject" both send a bare reject,
 * keeping back-compat with the existing endpoint behaviour.
 */
export function RejectReasonDialog({ open, onCancel, onReject }: RejectReasonDialogProps) {
  const [reason, setReason] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setReason("");
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => textareaRef.current?.focus(), 0);
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Capture phase + stopPropagation so parent Escape handlers (e.g. the
        // notification dropdown) don't also close while the dialog is open.
        event.stopPropagation();
        onCancel();
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
    window.addEventListener("keydown", handler, true);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handler, true);
      previousFocusRef.current?.focus();
    };
  }, [open, onCancel]);

  if (!open || typeof document === "undefined") return null;

  const trimmed = reason.trim();

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-900/40 px-4 backdrop-blur-[2px] transition-opacity duration-150 ease-strong starting:opacity-0 motion-reduce:transition-none">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reject-reason-title"
        className="panel-elevated w-full max-w-sm origin-center rounded-2xl border border-slate-200/70 bg-white p-6 transition duration-150 ease-strong starting:scale-[0.97] starting:opacity-0 motion-reduce:transition-none"
      >
        <h3
          id="reject-reason-title"
          className="mb-2 text-base font-semibold tracking-[-0.01em] text-slate-900"
        >
          Reject this suggestion?
        </h3>
        <label htmlFor="reject-reason" className="mb-2 block text-sm text-slate-500">
          Why? Helps Klorn avoid proposing this again — optional
        </label>
        <textarea
          id="reject-reason"
          ref={textareaRef}
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, MAX_REJECT_REASON_LENGTH))}
          maxLength={MAX_REJECT_REASON_LENGTH}
          rows={3}
          placeholder="e.g. Wrong recipient, bad timing, not my task"
          className="w-full resize-none rounded-lg border border-slate-200 bg-white/80 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 outline-none transition duration-150 ease-out focus:border-accent/50 focus:bg-white focus:ring-2 focus:ring-accent/15"
        />
        <p className="mt-1 text-right text-[10px] tabular-nums text-slate-400">
          {reason.length}/{MAX_REJECT_REASON_LENGTH}
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="ease-strong inline-flex min-h-11 items-center rounded-lg px-3 py-2 text-sm text-slate-500 transition duration-150 hover:text-slate-900 active:scale-[0.97]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onReject(null)}
            className="ease-strong inline-flex min-h-11 items-center rounded-lg border border-slate-200 bg-white/70 px-3 py-2 text-sm text-slate-500 transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97]"
          >
            Skip &amp; Reject
          </button>
          <button
            type="button"
            onClick={() => onReject(trimmed || null)}
            className="ease-strong inline-flex min-h-11 items-center rounded-lg bg-gradient-to-b from-red-500 to-red-600 px-4 py-2 text-sm font-medium text-white shadow-[0_1px_2px_rgba(127,29,29,0.3),0_8px_18px_-8px_rgba(220,38,38,0.5)] transition duration-150 hover:from-red-500 hover:to-red-700 active:scale-[0.97]"
          >
            Reject
          </button>
        </div>
      </div>
    </div>,
    document.body,
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
