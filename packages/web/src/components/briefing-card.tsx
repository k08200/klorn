"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { captureClientError } from "../lib/sentry";

type PushState =
  | "received"
  | "accepted"
  | "failed"
  | "skipped"
  | "pending"
  | "not_sent"
  | "no_subscription";

interface BriefingStatus {
  generated: boolean;
  note: {
    id: string;
    content: string;
    preview: string;
    createdAt: string;
  } | null;
  push: {
    state: PushState;
    reason: string | null;
    acceptedAt: string | null;
    receivedAt: string | null;
    clickedAt: string | null;
  };
  automation: {
    configured: boolean;
    enabled: boolean;
    briefingTime: string | null;
    timezone: string;
    reason: "no_config" | "disabled" | null;
  };
}

const EMPTY_STATUS: BriefingStatus = {
  generated: false,
  note: null,
  push: {
    state: "not_sent",
    reason: null,
    acceptedAt: null,
    receivedAt: null,
    clickedAt: null,
  },
  automation: {
    configured: false,
    enabled: false,
    briefingTime: null,
    timezone: "Asia/Seoul",
    reason: "no_config",
  },
};

export default function BriefingCard() {
  const [status, setStatus] = useState<BriefingStatus>(EMPTY_STATUS);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await apiFetch<BriefingStatus>("/api/briefing/status").catch(() => EMPTY_STATUS);
      setStatus({
        ...EMPTY_STATUS,
        ...data,
        push: { ...EMPTY_STATUS.push, ...data.push },
        automation: { ...EMPTY_STATUS.automation, ...data.automation },
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener("conversations-updated", handler);
    return () => window.removeEventListener("conversations-updated", handler);
  }, [refresh]);

  const generate = async () => {
    if (generating) return;
    setGenerating(true);
    setError(null);
    try {
      await apiFetch("/api/briefing/generate", {
        method: "POST",
        body: JSON.stringify({}),
      });
      await refresh();
    } catch (err) {
      captureClientError(err, { scope: "briefing-card.generate" });
      setError("Could not create the briefing.");
    } finally {
      setGenerating(false);
    }
  };

  if (loading) {
    return (
      <section className="mb-6 rounded-xl border border-stone-800 bg-stone-900/40 p-4">
        <div className="h-16 animate-pulse rounded-lg bg-stone-800/70" />
      </section>
    );
  }

  const push = pushMeta(status.push.state, status.push.reason);
  const time =
    status.note?.createdAt && !Number.isNaN(new Date(status.note.createdAt).getTime())
      ? formatTime(status.note.createdAt)
      : status.automation.briefingTime;

  return (
    <section className="mb-6 rounded-xl border border-stone-800 bg-stone-900/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-stone-100">Today's briefing</h2>
            <span className={`inline-flex items-center gap-1 text-[11px] ${push.className}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${push.dotClassName}`} />
              {push.label}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-stone-400">
            {status.note?.preview || emptyMessage(status)}
          </p>
          {time && <p className="mt-2 text-[11px] text-stone-600">{time}</p>}
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        </div>

        {status.generated ? (
          <Link
            href="/briefing"
            className="shrink-0 rounded-lg border border-stone-700 px-3 py-1.5 text-xs text-stone-300 transition hover:bg-stone-800"
          >
            Open
          </Link>
        ) : (
          <button
            type="button"
            onClick={generate}
            disabled={generating}
            className="shrink-0 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-black transition hover:bg-stone-200 disabled:opacity-50"
          >
            {generating ? "Creating..." : "Create now"}
          </button>
        )}
      </div>
    </section>
  );
}

function emptyMessage(status: BriefingStatus): string {
  if (status.automation.reason === "disabled") return "Automatic briefings are turned off.";
  if (status.automation.reason === "no_config") return "Briefing setup is not complete yet.";
  if (status.automation.briefingTime) {
    return `Automatic briefing will be ready at ${status.automation.briefingTime}.`;
  }
  return "No briefing for today yet.";
}

function pushMeta(
  state: PushState,
  reason: string | null,
): { label: string; className: string; dotClassName: string } {
  switch (state) {
    case "received":
      return { label: "Received", className: "text-emerald-300", dotClassName: "bg-emerald-400" };
    case "accepted":
      return { label: "Sent", className: "text-sky-300", dotClassName: "bg-sky-400" };
    case "failed":
      return { label: "Failed", className: "text-red-300", dotClassName: "bg-red-400" };
    case "skipped":
      return {
        label: skipReasonLabel(reason),
        className: "text-amber-300",
        dotClassName: "bg-amber-300",
      };
    case "pending":
      return { label: "Pending", className: "text-stone-400", dotClassName: "bg-stone-500" };
    case "not_sent":
      return { label: "Not sent", className: "text-stone-500", dotClassName: "bg-stone-600" };
    case "no_subscription":
      return {
        label: "No browser subscription",
        className: "text-stone-500",
        dotClassName: "bg-stone-600",
      };
  }
}

function skipReasonLabel(reason: string | null): string {
  if (!reason) return "Skipped";
  if (reason === "quiet_hours") return "Quiet hours";
  if (reason === "user_preferences") return "Notifications off";
  // Legacy rows logged before the reasons were split apart.
  if (reason === "user_preferences_or_quiet_hours") return "Quiet hours";
  if (reason.startsWith("rate_limited")) return "Rate limited";
  if (reason === "missing_vapid_keys") return "Push setup needed";
  return "Skipped";
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
