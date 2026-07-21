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
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[10000] px-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reject-reason-title"
        className="bg-white border border-slate-200 rounded-xl p-6 w-full max-w-sm animate-slide-up"
      >
        <h3 id="reject-reason-title" className="font-semibold mb-2">
          Reject this suggestion?
        </h3>
        <label htmlFor="reject-reason" className="block text-sm text-slate-500 mb-2">
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
          className="w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 transition focus:border-sky-300 focus:outline-none"
        />
        <p className="mt-1 text-right text-[10px] text-slate-500">
          {reason.length}/{MAX_REJECT_REASON_LENGTH}
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="min-h-11 px-3 py-2 rounded-lg text-sm text-slate-500 hover:text-slate-900 transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onReject(null)}
            className="min-h-11 px-3 py-2 rounded-lg text-sm border border-slate-200 text-slate-500 hover:bg-slate-100 transition"
          >
            Skip &amp; Reject
          </button>
          <button
            type="button"
            onClick={() => onReject(trimmed || null)}
            className="min-h-11 px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-500 text-white transition"
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
