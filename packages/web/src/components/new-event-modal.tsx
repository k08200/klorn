"use client";

import { useEffect, useId, useRef, useState } from "react";
import { apiFetch } from "../lib/api";

/**
 * Minimal create-event dialog for /calendar. POSTs to /api/calendar, which
 * writes to Google Calendar first (calendar.events) and then persists the
 * local row. Follows the compose-modal a11y pattern: focus the first field on
 * open, trap Tab inside the dialog, Escape dismisses (never mid-save), restore
 * focus to the trigger on close.
 */

const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white/80 px-3 py-2 text-sm text-slate-900 shadow-[0_1px_1px_rgba(15,23,42,0.03)] outline-none transition duration-150 ease-out placeholder:text-slate-400 focus:border-accent/50 focus:bg-white focus:ring-2 focus:ring-accent/15 disabled:opacity-60";

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local YYYY-MM-DD for <input type="date"> */
function localDateValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Next full hour as HH:MM for <input type="time"> */
function nextHourValue(d: Date): string {
  return `${pad((d.getHours() + 1) % 24)}:00`;
}

function plusOneHour(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${pad(((h ?? 0) + 1) % 24)}:${pad(m ?? 0)}`;
}

export interface NewEventInitial {
  title?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  location?: string;
}

export function NewEventModal({
  open,
  onClose,
  onCreated,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  /** Called after a successful create so the page can refetch/toast. */
  onCreated: (title: string) => void;
  /** Prefill (e.g. from a parsed voice transcript). Applied each time the dialog opens. */
  initial?: NewEventInitial | null;
}) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("10:00");
  const [location, setLocation] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const headingId = useId();

  // Seed each time the dialog opens: the voice-parsed prefill when provided,
  // otherwise the defaults (today, next full hour).
  useEffect(() => {
    if (!open) return;
    const now = new Date();
    const start = initial?.startTime || nextHourValue(now);
    setTitle(initial?.title ?? "");
    setDate(initial?.date || localDateValue(now));
    setStartTime(start);
    setEndTime(initial?.endTime || plusOneHour(start));
    setLocation(initial?.location ?? "");
    setError(null);
    setSaving(false);
  }, [open, initial]);

  // Focus/trap/restore — read `saving` through a ref so the effect keys on
  // [open] alone and its cleanup can't fire (yanking focus) mid-save.
  const savingRef = useRef(saving);
  savingRef.current = saving;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => titleInputRef.current?.focus(), 0);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!savingRef.current) closeRef.current();
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

  const startsBeforeEnds = startTime < endTime;
  const canSave = title.trim().length > 0 && date.length > 0 && startsBeforeEnds && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const start = new Date(`${date}T${startTime}`);
      const end = new Date(`${date}T${endTime}`);
      await apiFetch("/api/calendar", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          ...(location.trim() ? { location: location.trim() } : {}),
        }),
      });
      onCreated(title.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the event");
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center">
      <button
        type="button"
        aria-label="Close new event dialog"
        onClick={() => {
          if (!saving) onClose();
        }}
        className="absolute inset-0 bg-black/60"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="panel-elevated relative w-full max-w-md animate-slide-up rounded-t-2xl border border-slate-200/70 bg-white p-5 shadow-2xl shadow-slate-900/10 md:rounded-2xl"
      >
        <h2 id={headingId} className="text-base font-semibold text-slate-900">
          New event
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          Created in your Google Calendar and synced back here.
        </p>

        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div>
            <label htmlFor={`${headingId}-title`} className="mb-1 block text-xs text-slate-500">
              Title
            </label>
            <input
              id={`${headingId}-title`}
              ref={titleInputRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Coffee with John"
              maxLength={200}
              disabled={saving}
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-1">
              <label htmlFor={`${headingId}-date`} className="mb-1 block text-xs text-slate-500">
                Date
              </label>
              <input
                id={`${headingId}-date`}
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                disabled={saving}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor={`${headingId}-start`} className="mb-1 block text-xs text-slate-500">
                Starts
              </label>
              <input
                id={`${headingId}-start`}
                type="time"
                value={startTime}
                onChange={(e) => {
                  setStartTime(e.target.value);
                  // Keep a sane default range while the user edits.
                  if (e.target.value >= endTime) setEndTime(plusOneHour(e.target.value));
                }}
                disabled={saving}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor={`${headingId}-end`} className="mb-1 block text-xs text-slate-500">
                Ends
              </label>
              <input
                id={`${headingId}-end`}
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                disabled={saving}
                className={inputClass}
              />
            </div>
          </div>
          {!startsBeforeEnds && (
            <p className="text-xs text-red-600">End time must be after the start time.</p>
          )}

          <div>
            <label htmlFor={`${headingId}-location`} className="mb-1 block text-xs text-slate-500">
              Location <span className="text-slate-400">(optional)</span>
            </label>
            <input
              id={`${headingId}-location`}
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Meeting room / address / link"
              maxLength={300}
              disabled={saving}
              className={inputClass}
            />
          </div>

          {error && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="ease-strong min-h-10 rounded-lg border border-slate-200 bg-white/70 px-4 text-sm text-slate-500 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSave}
              className="glow-primary ease-strong min-h-10 rounded-lg bg-gradient-to-b from-sky-400 to-sky-500 px-4 text-sm font-medium text-white transition duration-150 hover:from-sky-400 hover:to-sky-600 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? "Creating..." : "Create event"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
