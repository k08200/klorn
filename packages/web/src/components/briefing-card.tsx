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
      setStatus(data);
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
  const time = status.note ? formatTime(status.note.createdAt) : status.automation.briefingTime;

  return (
    <section className="mb-6 rounded-xl border border-stone-800 bg-stone-900/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-stone-100">Today briefing</h2>
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
            열기
          </Link>
        ) : (
          <button
            type="button"
            onClick={generate}
            disabled={generating}
            className="shrink-0 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-black transition hover:bg-stone-200 disabled:opacity-50"
          >
            {generating ? "생성 중..." : "지금 생성"}
          </button>
        )}
      </div>
    </section>
  );
}

function emptyMessage(status: BriefingStatus): string {
  if (status.automation.reason === "disabled") return "자동 브리핑이 꺼져 있어요.";
  if (status.automation.reason === "no_config") return "브리핑 설정이 아직 끝나지 않았어요.";
  if (status.automation.briefingTime) {
    return `${status.automation.briefingTime}에 자동 브리핑이 준비돼요.`;
  }
  return "오늘 브리핑은 아직 없어요.";
}

function pushMeta(
  state: PushState,
  reason: string | null,
): { label: string; className: string; dotClassName: string } {
  switch (state) {
    case "received":
      return { label: "도착", className: "text-emerald-300", dotClassName: "bg-emerald-400" };
    case "accepted":
      return { label: "발송됨", className: "text-sky-300", dotClassName: "bg-sky-400" };
    case "failed":
      return { label: "실패", className: "text-red-300", dotClassName: "bg-red-400" };
    case "skipped":
      return {
        label: skipReasonLabel(reason),
        className: "text-amber-300",
        dotClassName: "bg-amber-300",
      };
    case "pending":
      return { label: "대기 중", className: "text-stone-400", dotClassName: "bg-stone-500" };
    case "not_sent":
      return { label: "미발송", className: "text-stone-500", dotClassName: "bg-stone-600" };
    case "no_subscription":
      return {
        label: "구독 기기 없음",
        className: "text-stone-500",
        dotClassName: "bg-stone-600",
      };
  }
}

function skipReasonLabel(reason: string | null): string {
  if (!reason) return "건너뜀";
  if (reason === "user_preferences_or_quiet_hours") return "방해 금지 시간";
  if (reason.startsWith("rate_limited")) return "전송 제한";
  if (reason === "missing_vapid_keys") return "푸시 설정 필요";
  return "건너뜀";
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
