"use client";

import { type ChangeEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { API_BASE, getStoredAuthToken } from "../lib/api";
import { captureClientError } from "../lib/sentry";
import { useConfirm } from "./confirm-dialog";
import { useToast } from "./toast";

// Mirror the server caps (packages/api/src/routes/email-mutations.ts) so the
// user gets an instant client-side warning instead of a round-trip rejection.
const MAX_ATTACHMENTS = 10;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

interface ComposeModalProps {
  open: boolean;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const fieldClass =
  "w-full rounded-md border border-white/10 bg-stone-950/60 px-3 py-2 text-sm text-stone-100 outline-none transition placeholder:text-stone-400 focus:border-accent/45 disabled:opacity-60";

export function ComposeModal({ open, onClose }: ComposeModalProps) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  const reset = useCallback(() => {
    setTo("");
    setSubject("");
    setBody("");
    setFiles([]);
    setError(null);
    setSending(false);
  }, []);

  const close = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  // Read sending/close inside the keydown handler via refs so the focus effect
  // can key on [open] ALONE. Keying it on `sending` too would re-run the effect
  // mid-send, firing its cleanup (focus-restore) and yanking focus out of the
  // modal while a send is in flight.
  const sendingRef = useRef(sending);
  sendingRef.current = sending;
  const closeRef = useRef(close);
  closeRef.current = close;

  // Focus the first field on open, TRAP Tab within the dialog (WCAG 2.1.2 /
  // 2.4.3 — focus must not leak to the page behind the modal), and RESTORE focus
  // to the trigger on close. Escape dismisses, but never mid-send so a stray
  // keypress can't abandon a request the server may already be running.
  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => toInputRef.current?.focus(), 0);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!sendingRef.current) closeRef.current();
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
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKey);
      previousFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const overSize = totalBytes > MAX_TOTAL_BYTES;
  const tooMany = files.length > MAX_ATTACHMENTS;

  const addFiles = (incoming: FileList | null) => {
    if (!incoming || incoming.length === 0) return;
    setError(null);
    setFiles((prev) => {
      const merged = [...prev];
      for (const file of Array.from(incoming)) {
        // De-dup by name+size so re-picking the same file doesn't double it.
        if (!merged.some((m) => m.name === file.name && m.size === file.size)) {
          merged.push(file);
        }
      }
      // Keep one past the cap so the "too many" warning renders instead of
      // silently dropping a file the user just chose.
      return merged.slice(0, MAX_ATTACHMENTS + 1);
    });
  };

  const onFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles(event.target.files);
    // Reset so selecting the same file again still fires onChange.
    event.target.value = "";
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const canSend =
    to.trim().length > 0 &&
    subject.trim().length > 0 &&
    body.trim().length > 0 &&
    !overSize &&
    !tooMany &&
    !sending;

  const send = async () => {
    if (!canSend) return;
    const confirmed = await confirm({
      title: "Send this email?",
      message:
        `To: ${to.trim()}\nSubject: ${subject.trim()}` +
        (files.length > 0
          ? `\nAttachments: ${files.length} file(s), ${formatBytes(totalBytes)}`
          : ""),
      confirmLabel: "Send",
    });
    if (!confirmed) return;

    setSending(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("to", to.trim());
      form.append("subject", subject.trim());
      form.append("body", body);
      for (const file of files) form.append("files", file);

      // Raw fetch (not apiFetch): apiFetch forces Content-Type: application/json,
      // which would corrupt the multipart boundary. Let the browser set it.
      const token = getStoredAuthToken();
      const res = await fetch(`${API_BASE}/api/email/compose`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      });

      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        const message =
          (payload && typeof payload.error === "string" && payload.error) ||
          `Send failed (${res.status}).`;
        // Emit a client signal too — a server-side outage is invisible here
        // when the API's own Sentry DSN is unset (the local/dev default).
        captureClientError(new Error(`compose HTTP ${res.status}: ${message}`), {
          context: "compose.send.http-error",
        });
        setError(message);
        setSending(false);
        return;
      }

      toast(files.length > 0 ? `Email sent with ${files.length} attachment(s)` : "Email sent");
      close();
    } catch (err) {
      captureClientError(err, { context: "compose.send" });
      setError("Could not reach the server. Check your connection and try again.");
      setSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 px-4 py-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !sending) close();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-stone-700 bg-stone-950 shadow-2xl shadow-black/40"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h2 id={titleId} className="text-base font-semibold text-stone-100">
            New message
          </h2>
          <button
            type="button"
            onClick={close}
            disabled={sending}
            aria-label="Close"
            className="min-h-9 rounded-md px-2 text-stone-500 transition hover:text-stone-200 disabled:opacity-50"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <div>
            <label htmlFor="compose-to" className="sr-only">
              Recipient
            </label>
            <input
              id="compose-to"
              ref={toInputRef}
              type="email"
              inputMode="email"
              autoComplete="email"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              placeholder="To"
              disabled={sending}
              className={fieldClass}
            />
          </div>
          <div>
            <label htmlFor="compose-subject" className="sr-only">
              Subject
            </label>
            <input
              id="compose-subject"
              type="text"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="Subject"
              disabled={sending}
              className={fieldClass}
            />
          </div>
          <div>
            <label htmlFor="compose-body" className="sr-only">
              Message
            </label>
            <textarea
              id="compose-body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Write your message…"
              rows={8}
              disabled={sending}
              className={`${fieldClass} resize-y leading-6`}
            />
          </div>

          {files.length > 0 && (
            <ul className="space-y-1.5">
              {files.map((file, index) => (
                <li
                  key={`${file.name}-${file.size}`}
                  className="flex items-center justify-between gap-2 rounded-md border border-white/10 bg-stone-900/50 px-3 py-2 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate text-stone-200" title={file.name}>
                    📎 {file.name}
                  </span>
                  <span className="shrink-0 text-stone-500">{formatBytes(file.size)}</span>
                  <button
                    type="button"
                    onClick={() => removeFile(index)}
                    disabled={sending}
                    aria-label={`Remove ${file.name}`}
                    className="shrink-0 rounded px-1 text-stone-500 transition hover:text-red-300 disabled:opacity-50"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}

          {tooMany && (
            <p className="text-xs text-red-300">You can attach at most {MAX_ATTACHMENTS} files.</p>
          )}
          {overSize && (
            <p className="text-xs text-red-300">
              Attachments are {formatBytes(totalBytes)} — the limit is{" "}
              {formatBytes(MAX_TOTAL_BYTES)}.
            </p>
          )}
          {error && (
            <p className="rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-white/10 px-5 py-4">
          <input ref={fileInputRef} type="file" multiple hidden onChange={onFileInputChange} />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            className="min-h-11 rounded-md border border-white/10 bg-stone-950/60 px-3 text-xs font-medium text-stone-300 transition hover:border-white/20 hover:text-stone-100 disabled:opacity-50"
          >
            📎 Attach files
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={close}
              disabled={sending}
              className="min-h-11 rounded-md px-4 text-sm text-stone-400 transition hover:text-stone-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              className="min-h-11 rounded-md bg-accent px-4 text-sm font-medium text-stone-950 transition hover:bg-accent-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
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
