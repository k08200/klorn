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
    <div className="mt-2 rounded-xl border border-slate-200/70 bg-white p-3 text-sm shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <span className="inline-flex rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-sky-600 ring-1 ring-inset ring-sky-500/20">
        {t("draft.title")}
      </span>
      <p className="mt-1.5 font-medium text-slate-900">{draft.title}</p>
      <p className="mt-0.5 text-slate-500">{formatRange(draft.startTime, draft.endTime)}</p>
      {draft.location && <p className="mt-0.5 text-slate-500">{draft.location}</p>}

      {state === "saved" ? (
        <p className="mt-2 text-emerald-600">{t("draft.saved")}</p>
      ) : state === "paywalled" ? (
        <p className="mt-2 text-slate-500">
          {t("draft.paywall")}{" "}
          <Link href="/billing" className="focus-ring text-sky-600 underline">
            {t("draft.seePlans")}
          </Link>
        </p>
      ) : (
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={state === "saving"}
            className="focus-ring glow-primary ease-strong min-h-[44px] rounded-lg bg-gradient-to-b from-sky-400 to-sky-500 px-4 text-sm font-medium text-white transition duration-150 hover:from-sky-400 hover:to-sky-600 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {state === "saving" ? t("draft.saving") : t("draft.save")}
          </button>
          {state === "error" && errorMessage && <p className="text-red-700">{errorMessage}</p>}
        </div>
      )}
    </div>
  );
}
