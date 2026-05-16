"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { apiFetch } from "../../lib/api";
import { captureClientError } from "../../lib/sentry";

interface AgentLogEntry {
  id: string;
  action: string; // "notify" | "tool_call" | "skip" | "error" | "auto_action"
  tool: string | null;
  summary: string;
  reasoning: string | null;
  createdAt: string;
}

interface AgentLogsResponse {
  logs: AgentLogEntry[];
}

interface AgentStats {
  total: number;
  toolCalls: number;
  notifications: number;
  skips: number;
  errors: number;
}

const PAGE_SIZE = 30;

export default function AgentPage() {
  return (
    <AuthGuard>
      <AgentTimeline />
    </AuthGuard>
  );
}

function AgentTimeline() {
  const [logs, setLogs] = useState<AgentLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [filter, setFilter] = useState<string>("all");

  const load = useCallback(async (offset = 0, replace = true) => {
    if (offset === 0) setLoading(true);
    else setLoadingMore(true);
    setError(null);
    try {
      const data = await apiFetch<AgentLogsResponse>(
        `/api/automations/agent-logs?limit=${PAGE_SIZE}&offset=${offset}`,
      );
      const newLogs = Array.isArray(data.logs) ? data.logs : [];
      setLogs((prev) => replace ? newLogs : [...prev, ...newLogs]);
      setHasMore(newLogs.length === PAGE_SIZE);
    } catch (err) {
      captureClientError(err, { scope: "agent-timeline.load" });
      setError("Could not load agent activity.");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    load(0, true);
  }, [load]);

  const filtered = filter === "all" ? logs : logs.filter((l) => l.action === filter);

  const stats = computeStats(logs);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:py-10">
      {/* Header */}
      <header className="mb-6 overflow-hidden rounded-lg border border-stone-700/40 bg-stone-950/65 shadow-2xl shadow-black/20">
        <div className="h-1 bg-gradient-to-r from-stone-600 via-amber-300 to-teal-300" />
        <div className="p-5 md:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-400">
                Agent timeline
              </p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-stone-50">
                What Jigeum did and why
              </h1>
              <p className="mt-2 text-sm leading-6 text-stone-400">
                Every decision, proposal, and action — with the reasoning behind it.
              </p>
            </div>
            <div className="shrink-0 flex gap-2">
              <button
                type="button"
                onClick={() => load(0, true)}
                className="h-8 rounded-md border border-stone-700 bg-stone-950/70 px-3 text-xs text-stone-300 transition hover:bg-stone-800"
              >
                Refresh
              </button>
              <Link
                href="/settings"
                className="inline-flex h-8 items-center rounded-md border border-stone-700 px-3 text-xs text-stone-300 transition hover:bg-stone-800"
              >
                Settings
              </Link>
            </div>
          </div>

          {/* Stats */}
          <div className="mt-5 grid grid-cols-5 overflow-hidden rounded-xl border border-white/10 bg-black/25">
            <StatMetric label="Total actions" value={stats.total} color="text-stone-50" />
            <StatMetric label="Tool calls" value={stats.toolCalls} color="text-amber-300" />
            <StatMetric label="Notifications" value={stats.notifications} color="text-teal-300" />
            <StatMetric label="Skipped" value={stats.skips} color="text-stone-400" />
            <StatMetric label="Errors" value={stats.errors} color="text-red-400" />
          </div>

          {/* Filter */}
          <div className="mt-4 flex items-center gap-1 rounded-lg border border-stone-800 bg-stone-950/80 p-1 w-fit">
            {[
              { value: "all", label: "All" },
              { value: "tool_call", label: "Tool calls" },
              { value: "notify", label: "Notifications" },
              { value: "skip", label: "Skipped" },
              { value: "error", label: "Errors" },
            ].map(({ value, label }) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={`text-xs px-3 py-1.5 rounded-md transition ${
                  filter === value
                    ? "bg-stone-800 text-white"
                    : "text-stone-400 hover:text-stone-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Content */}
      {loading && (
        <p className="text-center text-sm text-stone-500 py-10">Loading agent activity...</p>
      )}

      {error && (
        <div className="rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="rounded-lg border border-stone-800 bg-stone-900/40 p-8 text-center">
          <p className="text-sm text-stone-400">No agent activity found.</p>
          <p className="mt-1 text-xs text-stone-600">
            Enable the autonomous agent in Settings to start seeing activity here.
          </p>
          <div className="mt-4">
            <Link
              href="/settings"
              className="inline-flex items-center justify-center h-9 rounded-md bg-amber-300 px-4 text-sm font-semibold text-stone-950 transition hover:bg-amber-200"
            >
              Enable agent
            </Link>
          </div>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="relative">
          {/* Timeline spine */}
          <div className="absolute left-[11px] top-0 bottom-0 w-px bg-stone-800" aria-hidden="true" />

          <ul className="space-y-1">
            {filtered.map((log, idx) => (
              <li key={log.id}>
                <TimelineEntry log={log} isFirst={idx === 0} />
              </li>
            ))}
          </ul>

          {hasMore && (
            <div className="mt-6 flex justify-center">
              <button
                type="button"
                onClick={() => load(logs.length, false)}
                disabled={loadingMore}
                className="inline-flex items-center gap-2 rounded-md border border-stone-700 px-4 py-2 text-sm text-stone-300 transition hover:bg-stone-800 disabled:opacity-50"
              >
                {loadingMore ? (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-stone-300/30 border-t-stone-200" />
                ) : null}
                Load more
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TimelineEntry({ log, isFirst }: { log: AgentLogEntry; isFirst: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const { icon, dotClass, labelClass, actionLabel } = actionStyle(log.action, log.tool);
  const hasReasoning = !!log.reasoning && log.reasoning.length > 10;

  return (
    <div className="flex gap-4 pl-1">
      {/* Dot */}
      <div className={`relative mt-3 h-6 w-6 shrink-0 flex items-center justify-center rounded-full border ${dotClass} z-10`}>
        <span className="text-[11px]">{icon}</span>
      </div>

      {/* Card */}
      <div
        className={`flex-1 mb-1 rounded-lg border border-stone-800 bg-stone-950/40 p-3 ${hasReasoning ? "cursor-pointer hover:bg-stone-900/60 transition" : ""}`}
        onClick={hasReasoning ? () => setExpanded((e) => !e) : undefined}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${labelClass}`}>
                {actionLabel}
              </span>
              {log.tool && (
                <span className="text-[11px] text-stone-500 bg-stone-800/60 border border-stone-700/60 rounded px-1.5 py-0.5">
                  {log.tool.replace(/_/g, " ")}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-stone-200">{log.summary}</p>

            {expanded && hasReasoning && (
              <div className="mt-3 rounded border border-stone-700/50 bg-black/20 p-3">
                <p className="text-[11px] font-mono uppercase tracking-wider text-stone-500 mb-1">Reasoning</p>
                <p className="text-xs text-stone-400 whitespace-pre-wrap leading-5">{log.reasoning}</p>
              </div>
            )}
          </div>

          <div className="shrink-0 flex flex-col items-end gap-1">
            <span className="text-[11px] text-stone-600 whitespace-nowrap">
              {formatTimestamp(log.createdAt)}
            </span>
            {hasReasoning && (
              <span className="text-[10px] text-stone-600">
                {expanded ? "▲ hide" : "▼ why"}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatMetric({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="border-r border-white/10 px-3 py-3 last:border-r-0">
      <p className={`text-xl font-semibold ${color}`}>{value}</p>
      <p className="mt-0.5 text-[10px] text-stone-500 leading-3">{label}</p>
    </div>
  );
}

function actionStyle(action: string, tool: string | null): {
  icon: string;
  dotClass: string;
  labelClass: string;
  actionLabel: string;
} {
  if (action === "tool_call" || action === "auto_action") {
    if (tool?.includes("send_email") || tool?.includes("email")) {
      return { icon: "✉", dotClass: "border-amber-500/40 bg-amber-950/30", labelClass: "text-amber-300", actionLabel: "Email action" };
    }
    if (tool?.includes("event") || tool?.includes("calendar")) {
      return { icon: "📅", dotClass: "border-teal-500/40 bg-teal-950/30", labelClass: "text-teal-300", actionLabel: "Calendar action" };
    }
    if (tool?.includes("task")) {
      return { icon: "✓", dotClass: "border-emerald-500/40 bg-emerald-950/30", labelClass: "text-emerald-300", actionLabel: "Task action" };
    }
    if (tool?.includes("reminder")) {
      return { icon: "⏰", dotClass: "border-blue-500/40 bg-blue-950/30", labelClass: "text-blue-300", actionLabel: "Reminder action" };
    }
    if (tool?.includes("delete") || tool?.includes("archive")) {
      return { icon: "🗑", dotClass: "border-red-500/40 bg-red-950/30", labelClass: "text-red-300", actionLabel: "Destructive action" };
    }
    return { icon: "⚡", dotClass: "border-amber-400/30 bg-amber-950/20", labelClass: "text-amber-200", actionLabel: "Tool call" };
  }
  if (action === "notify") {
    return { icon: "🔔", dotClass: "border-teal-500/40 bg-teal-950/30", labelClass: "text-teal-300", actionLabel: "Notification" };
  }
  if (action === "skip") {
    return { icon: "—", dotClass: "border-stone-700 bg-stone-900/20", labelClass: "text-stone-500", actionLabel: "Skipped" };
  }
  if (action === "error") {
    return { icon: "!", dotClass: "border-red-500/40 bg-red-950/30", labelClass: "text-red-400", actionLabel: "Error" };
  }
  return { icon: "·", dotClass: "border-stone-700 bg-stone-900", labelClass: "text-stone-400", actionLabel: action };
}

function computeStats(logs: AgentLogEntry[]): AgentStats {
  return {
    total: logs.length,
    toolCalls: logs.filter((l) => l.action === "tool_call" || l.action === "auto_action").length,
    notifications: logs.filter((l) => l.action === "notify").length,
    skips: logs.filter((l) => l.action === "skip").length,
    errors: logs.filter((l) => l.action === "error").length,
  };
}

function formatTimestamp(isoStr: string): string {
  const d = new Date(isoStr);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
