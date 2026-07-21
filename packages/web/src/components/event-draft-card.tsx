"use client";

// Confirm card for an assistant-drafted calendar event. The chat engine never
// writes to the calendar — the save happens HERE, through the same Pro-gated
// POST /api/calendar the New event dialog uses, only after the user taps Save.

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { API_BASE, authHeaders } from "../lib/api";
import { useT } from "../lib/i18n";
import { queryKeys } from "../lib/query-keys";
import { captureClientError } from "../lib/sentry";

export interface EventDraft {
  title: string;
  startTime: string;
  endTime: string;
  location?: string;
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

type SaveState = "idle" | "saving" | "saved" | "paywalled" | "error";

export default function EventDraftCard({ draft }: { draft: EventDraft }) {
  const { t } = useT();
  const [state, setState] = useState<SaveState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const save = async () => {
    setState("saving");
    setErrorMessage(null);
    try {
      const res = await fetch(`${API_BASE}/api/calendar`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          title: draft.title,
          startTime: draft.startTime,
          endTime: draft.endTime,
          ...(draft.location ? { location: draft.location } : {}),
        }),
      });

      if (res.status === 402 || res.status === 403) {
        setState("paywalled");
        return;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
      }

      setState("saved");
      await queryClient.invalidateQueries({ queryKey: queryKeys.calendar.all });
    } catch (err) {
      console.error("[CHAT] event draft save failed:", err);
      captureClientError(err);
      setErrorMessage(t("draft.error"));
      setState("error");
    }
  };

  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{t("draft.title")}</p>
      <p className="mt-1 font-medium text-slate-900">{draft.title}</p>
      <p className="mt-0.5 text-slate-500">{formatRange(draft.startTime, draft.endTime)}</p>
      {draft.location && <p className="mt-0.5 text-slate-500">{draft.location}</p>}

      {state === "saved" ? (
        <p className="mt-2 text-emerald-400">{t("draft.saved")}</p>
      ) : state === "paywalled" ? (
        <p className="mt-2 text-slate-500">
          {t("draft.paywall")}{" "}
          <Link href="/billing" className="focus-ring text-accent underline">
            {t("draft.seePlans")}
          </Link>
        </p>
      ) : (
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={state === "saving"}
            className="focus-ring min-h-[44px] rounded-md bg-accent px-4 text-sm font-semibold text-stone-950 transition hover:bg-accent/90 disabled:opacity-50"
          >
            {state === "saving" ? t("draft.saving") : t("draft.save")}
          </button>
          {state === "error" && errorMessage && <p className="text-red-600">{errorMessage}</p>}
        </div>
      )}
    </div>
  );
}
