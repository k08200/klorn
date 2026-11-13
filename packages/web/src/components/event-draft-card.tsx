"use client";

// Confirm card for a calendar event. Nothing writes to the calendar until the
// user taps Save HERE: the chat engine only drafts (EventDraftCard, saved
// through the same Pro-gated POST /api/calendar the New event dialog uses), and
// the smart action "Add to calendar" only proposes (components/smart-actions/
// smart-event-card.tsx, which renders its editable fields inside this frame).

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { type ReactNode, useId, useState } from "react";
import { API_BASE, authHeaders } from "../lib/api";
import { useT } from "../lib/i18n";
import { queryKeys } from "../lib/query-keys";
import { captureClientError } from "../lib/sentry";

export interface EventDraft {
  title: string;
  startTime: string;
  endTime: string;
  location?: string;
  /** Invitees (team mode P2) — saving is what sends the invitations. */
  attendees?: string[];
}

function formatRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${startIso} – ${endIso}`;
  }
  const day = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    weekday: "short",
  }).format(start);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${day} · ${time.format(start)}–${time.format(end)}`;
}

/** What a Save did: written, refused for the plan, or back to the card (e.g. a duplicate to confirm). */
export type EventSaveOutcome = "saved" | "paywalled" | "retry";

type SaveState = "idle" | "saving" | "saved" | "paywalled" | "error";

interface EventConfirmFrameProps {
  children: ReactNode;
  save: () => Promise<EventSaveOutcome>;
  /** False keeps Save disabled (a question on the card is still open). */
  canSave?: boolean;
  /** Replaces "Save to calendar" (e.g. "Add anyway" after a duplicate). */
  saveLabel?: string;
  /** Shown under "Saved" (e.g. a reminder that could not be set). */
  savedNote?: string | null;
  /** Replaces the content once saved (a card whose content is editable fields). */
  savedSummary?: ReactNode;
  /** Why Save is disabled, read with the button. */
  saveHint?: string | null;
}

/** The confirm card's frame: badge, content, and the Save → saved / paywall / error states. */
export function EventConfirmFrame({
  children,
  save,
  canSave = true,
  saveLabel,
  savedNote,
  savedSummary,
  saveHint,
}: EventConfirmFrameProps) {
  const { t } = useT();
  const hintId = useId();
  const [state, setState] = useState<SaveState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const run = async () => {
    setState("saving");
    setErrorMessage(null);
    try {
      const outcome = await save();
      setState(outcome === "retry" ? "idle" : outcome);
    } catch (err) {
      console.error("[EVENT] event save failed:", err);
      captureClientError(err);
      setErrorMessage(t("draft.error"));
      setState("error");
    }
  };

  return (
    <div className="mt-2 rounded-card border border-line/70 bg-surface-panel p-3 text-role-body shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <span className="inline-flex rounded-chip bg-accent/10 px-1.5 py-0.5 text-role-caption font-bold uppercase tracking-wide text-accent-deep ring-1 ring-inset ring-accent/20">
        {t("draft.title")}
      </span>
      {state === "saved" && savedSummary !== undefined ? savedSummary : children}

      {state === "saved" ? (
        <div className="mt-2" role="status">
          <p className="text-state-ok-ink">{t("draft.saved")}</p>
          {savedNote && <p className="mt-0.5 text-role-caption text-ink-mid">{savedNote}</p>}
        </div>
      ) : state === "paywalled" ? (
        <p className="mt-2 text-ink-mid">
          {t("draft.paywall")}{" "}
          <Link href="/billing" className="focus-ring text-accent-deep underline">
            {t("draft.seePlans")}
          </Link>
        </p>
      ) : (
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void run()}
            disabled={state === "saving" || !canSave}
            aria-describedby={!canSave && saveHint ? hintId : undefined}
            className="focus-ring glow-primary ease-strong min-h-[44px] rounded-control bg-accent-solid px-4 text-role-label text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {state === "saving" ? t("draft.saving") : (saveLabel ?? t("draft.save"))}
          </button>
          {!canSave && saveHint && (
            <p id={hintId} className="text-role-caption text-ink-mid">
              {saveHint}
            </p>
          )}
          {state === "error" && errorMessage && (
            <p className="text-state-danger-ink" role="alert">
              {errorMessage}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function EventDraftCard({ draft }: { draft: EventDraft }) {
  const queryClient = useQueryClient();

  const save = async (): Promise<EventSaveOutcome> => {
    const res = await fetch(`${API_BASE}/api/calendar`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        title: draft.title,
        startTime: draft.startTime,
        endTime: draft.endTime,
        ...(draft.location ? { location: draft.location } : {}),
        ...(draft.attendees?.length ? { attendees: draft.attendees } : {}),
      }),
    });

    if (res.status === 402 || res.status === 403) return "paywalled";
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.calendar.all });
    return "saved";
  };

  return (
    <EventConfirmFrame save={save}>
      <p className="mt-1.5 font-medium text-ink">{draft.title}</p>
      <p className="mt-0.5 text-ink-mid">{formatRange(draft.startTime, draft.endTime)}</p>
      {draft.location && <p className="mt-0.5 text-ink-mid">{draft.location}</p>}
      {draft.attendees && draft.attendees.length > 0 && (
        <p className="mt-0.5 text-ink-mid">{draft.attendees.join(", ")}</p>
      )}
    </EventConfirmFrame>
  );
}
