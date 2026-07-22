"use client";

// Wire shape comes from @klorn/contract — the same type the server builds
// (pim/briefing-status.ts), so a response-shape change fails to compile here
// instead of silently desyncing.
import type { BriefingPushState, BriefingStatus } from "@klorn/contract";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { captureClientError } from "../lib/sentry";

const EMPTY_STATUS: BriefingStatus = {
  date: "",
  generated: false,
  note: null,
  notification: null,
  push: {
    state: "not_sent",
    reason: null,
    deliveryId: null,
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
      <section className="panel-elevated mb-6 rounded-2xl border border-slate-200/70 bg-white p-4">
        <div className="h-16 animate-pulse rounded-lg bg-slate-100" />
      </section>
    );
  }

  const push = pushMeta(status.push.state, status.push.reason);
  const time =
    status.note?.createdAt && !Number.isNaN(new Date(status.note.createdAt).getTime())
      ? formatTime(status.note.createdAt)
      : status.automation.briefingTime;

  return (
    <section className="panel-elevated mb-6 rounded-2xl border border-slate-200/70 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-900">Today's briefing</h2>
            <span className={`inline-flex items-center gap-1 text-[11px] ${push.className}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${push.dotClassName}`} />
              {push.label}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-slate-500">
            {status.note?.preview || emptyMessage(status)}
          </p>
          {time && <p className="mt-2 text-[11px] text-slate-500">{time}</p>}
          {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
        </div>

        {status.generated ? (
          <Link
            href="/briefing"
            className="ease-strong shrink-0 rounded-lg border border-slate-200 bg-white/70 px-3 py-1.5 text-xs font-medium text-slate-500 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97]"
          >
            Open
          </Link>
        ) : (
          <button
            type="button"
            onClick={generate}
            disabled={generating}
            className="glow-primary ease-strong shrink-0 rounded-lg bg-gradient-to-b from-sky-400 to-sky-500 px-3 py-1.5 text-xs font-medium text-white transition duration-150 hover:from-sky-400 hover:to-sky-600 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
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
  state: BriefingPushState,
  reason: string | null,
): { label: string; className: string; dotClassName: string } {
  switch (state) {
    case "received":
      return { label: "Received", className: "text-emerald-600", dotClassName: "bg-emerald-500" };
    case "accepted":
      return { label: "Sent", className: "text-slate-500", dotClassName: "bg-slate-400" };
    case "failed":
      return { label: "Failed", className: "text-red-700", dotClassName: "bg-red-500" };
    case "skipped":
      return {
        label: skipReasonLabel(reason),
        className: "text-amber-600",
        dotClassName: "bg-amber-400",
      };
    case "pending":
      return { label: "Pending", className: "text-slate-500", dotClassName: "bg-slate-400" };
    case "not_sent":
      return { label: "Not sent", className: "text-slate-400", dotClassName: "bg-slate-300" };
    case "no_subscription":
      return {
        label: "No browser subscription",
        className: "text-slate-400",
        dotClassName: "bg-slate-300",
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
