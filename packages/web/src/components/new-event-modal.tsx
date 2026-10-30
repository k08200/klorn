"use client";

import { useEffect, useId, useRef, useState } from "react";
import { apiFetch } from "../lib/api";
import { isEntitlementRefusal } from "../lib/entitlement";
import { useT } from "../lib/i18n";
import { serverErrorMessage } from "../lib/server-error";
import { ProFeatureNotice } from "./pro-feature-notice";
import ErrorAlert from "./ui/error-alert";

/**
 * Minimal create-event dialog for /calendar. POSTs to /api/calendar, which
 * writes to Google Calendar first (calendar.events) and then persists the
 * local row. Follows the compose-modal a11y pattern: focus the first field on
 * open, trap Tab inside the dialog, Escape dismisses (never mid-save), restore
 * focus to the trigger on close.
 */

const inputClass =
  "w-full rounded-lg border border-line bg-surface-panel/80 px-3 py-2 text-sm text-ink shadow-[0_1px_1px_rgba(15,23,42,0.03)] outline-none transition duration-150 ease-out placeholder:text-ink-dim focus:border-accent/50 focus:bg-surface-panel focus:ring-2 focus:ring-accent/15 disabled:opacity-60";

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
  const { t } = useT();
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("10:00");
  const [location, setLocation] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Creating events is Pro: a FREE user's 403 shows the upgrade notice.
  const [proGated, setProGated] = useState(false);

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
    setProGated(false);
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
    setProGated(false);
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
      if (isEntitlementRefusal(err)) setProGated(true);
      // The server's own sentence when it sent one, never the raw `API 4xx: {json}`.
      else setError(serverErrorMessage(err, t("newEvent.error.create")));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center">
      <button
        type="button"
        aria-label={t("newEvent.close")}
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
        className="panel-elevated relative w-full max-w-md animate-slide-up rounded-t-2xl border border-line/70 bg-surface-panel p-5 shadow-2xl shadow-slate-900/10 md:rounded-2xl"
      >
        <h2 id={headingId} className="text-base font-semibold text-ink">
          {t("calendar.newEvent")}
        </h2>
        <p className="mt-1 text-xs text-ink-dim">{t("newEvent.subtitle")}</p>

        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div>
            <label htmlFor={`${headingId}-title`} className="mb-1 block text-xs text-ink-mid">
              {t("newEvent.title")}
            </label>
            <input
              id={`${headingId}-title`}
              ref={titleInputRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("newEvent.titlePlaceholder")}
              maxLength={200}
              disabled={saving}
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-1">
              <label htmlFor={`${headingId}-date`} className="mb-1 block text-xs text-ink-mid">
                {t("newEvent.date")}
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
              <label htmlFor={`${headingId}-start`} className="mb-1 block text-xs text-ink-mid">
                {t("newEvent.starts")}
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
              <label htmlFor={`${headingId}-end`} className="mb-1 block text-xs text-ink-mid">
                {t("newEvent.ends")}
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
            <p className="text-xs text-state-danger-ink">{t("newEvent.endAfterStart")}</p>
          )}

          <div>
            <label htmlFor={`${headingId}-location`} className="mb-1 block text-xs text-ink-mid">
              {t("newEvent.location")}{" "}
              <span className="text-ink-dim">{t("newEvent.optional")}</span>
            </label>
            <input
              id={`${headingId}-location`}
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={t("newEvent.locationPlaceholder")}
              maxLength={300}
              disabled={saving}
              className={inputClass}
            />
          </div>

          {error && <ErrorAlert>{error}</ErrorAlert>}
          {proGated && <ProFeatureNotice />}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="ease-strong min-h-10 rounded-lg border border-line bg-surface-panel/70 px-4 text-sm text-ink-mid shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] disabled:opacity-50"
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              disabled={!canSave}
              className="glow-primary ease-strong min-h-10 rounded-lg bg-accent-solid px-4 text-sm font-medium text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? t("newEvent.creating") : t("newEvent.create")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
