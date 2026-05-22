"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { apiFetch } from "../../lib/api";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";
import { formatRelative } from "../../lib/text";
import type { WorkGraphContext, WorkGraphRisk, WorkGraphSummary } from "../../lib/work-graph";

type RiskFilter = "all" | "high" | "medium" | "low";
type KindFilter = "all" | "email_thread" | "chat_conversation" | "loose_commitment";

const EMPTY: WorkGraphSummary = { generatedAt: "", contexts: [] };

const RISK_META: Record<WorkGraphRisk, { label: string; className: string; dot: string }> = {
  high: {
    label: "High",
    className: "text-red-300 bg-red-500/10 border-red-500/20",
    dot: "bg-red-400",
  },
  medium: {
    label: "Medium",
    className: "text-amber-300 bg-amber-400/10 border-amber-400/20",
    dot: "bg-amber-400",
  },
  low: {
    label: "Low",
    className: "text-stone-400 bg-stone-500/10 border-stone-500/20",
    dot: "bg-stone-600",
  },
};

function kindLabel(kind: WorkGraphContext["kind"]): string {
  if (kind === "email_thread") return "Mail";
  if (kind === "chat_conversation") return "Thread";
  return "Commitment";
}

function signalChips(signals: WorkGraphContext["signals"]): string[] {
  const chips: string[] = [];
  if (signals.pendingActions)
    chips.push(`${signals.pendingActions} approval${signals.pendingActions > 1 ? "s" : ""}`);
  if (signals.overdueCommitments) chips.push(`${signals.overdueCommitments} overdue`);
  if (signals.commitments)
    chips.push(`${signals.commitments} commitment${signals.commitments > 1 ? "s" : ""}`);
  if (signals.urgentEmails) chips.push(`${signals.urgentEmails} urgent`);
  if (signals.unreadEmails) chips.push(`${signals.unreadEmails} unread`);
  if (chips.length === 0 && signals.emails) chips.push(`${signals.emails} mail`);
  return chips.slice(0, 4);
}

function ContextCard({ context }: { context: WorkGraphContext }) {
  const meta = RISK_META[context.risk];
  const chips = signalChips(context.signals);
  const people = (context.people ?? [])
    .map((p) => p.name || p.email)
    .filter(Boolean)
    .slice(0, 3) as string[];

  const body = (
    <article className="rounded-xl border border-stone-800 bg-stone-900/40 p-4 transition hover:border-amber-300/20 hover:bg-stone-900/70">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${meta.className}`}
            >
              {meta.label}
            </span>
            <span className="text-[11px] text-stone-600">{kindLabel(context.kind)}</span>
            <span className="text-[11px] text-stone-700">
              {formatRelative(context.lastActivityAt)}
            </span>
          </div>

          <p className="mt-2 break-words text-sm font-semibold text-stone-100">{context.title}</p>

          {context.subtitle && (
            <p className="mt-1 line-clamp-2 text-xs text-stone-500">{context.subtitle}</p>
          )}

          {chips.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {chips.map((chip) => (
                <span
                  key={chip}
                  className="rounded border border-stone-800 bg-black/20 px-1.5 py-0.5 text-[11px] text-stone-400"
                >
                  {chip}
                </span>
              ))}
            </div>
          )}

          {context.reasons.length > 0 && (
            <ul className="mt-3 space-y-1">
              {context.reasons.slice(0, 2).map((r) => (
                <li key={r} className="text-xs text-stone-500">
                  {r}
                </li>
              ))}
            </ul>
          )}

          {people.length > 0 && (
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[10px] text-stone-700">People</span>
              <div className="flex flex-wrap gap-1.5">
                {people.map((person) => (
                  <span
                    key={person}
                    className="rounded border border-stone-800 px-1.5 py-0.5 text-[11px] text-stone-500"
                  >
                    {person}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Risk glyph */}
        <div
          className={`hidden h-12 w-12 shrink-0 items-center justify-center rounded-full border md:flex ${meta.className}`}
          aria-hidden="true"
        >
          <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
        </div>
      </div>
    </article>
  );

  return context.href ? (
    <Link href={context.href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

function WorkGraphContent() {
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("all");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");

  const { data = EMPTY, isLoading: loading } = useQuery({
    queryKey: queryKeys.workGraph.summary(),
    queryFn: async () => {
      try {
        const res = await apiFetch<WorkGraphSummary>("/api/work-graph/summary");
        return {
          generatedAt: res.generatedAt ?? "",
          contexts: Array.isArray(res.contexts) ? res.contexts : [],
        };
      } catch (err) {
        captureClientError(err, { scope: "work-graph.load" });
        throw err;
      }
    },
  });

  const visible = data.contexts.filter((c) => {
    if (riskFilter !== "all" && c.risk !== riskFilter) return false;
    if (kindFilter !== "all" && c.kind !== kindFilter) return false;
    return true;
  });

  const counts = {
    high: data.contexts.filter((c) => c.risk === "high").length,
    medium: data.contexts.filter((c) => c.risk === "medium").length,
    low: data.contexts.filter((c) => c.risk === "low").length,
  };

  const totalSignals = data.contexts.reduce(
    (sum, c) => sum + Object.values(c.signals).reduce((s, v) => s + Number(v ?? 0), 0),
    0,
  );

  return (
    <div className="flex h-dvh flex-col bg-[#0f1115]">
      {/* Header */}
      <div className="border-b border-stone-800 px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-stone-100">Work graph</h1>
            <p className="mt-0.5 text-[12px] text-stone-500">
              Active contexts inferred from your mail, threads, and commitments.
            </p>
          </div>

          {/* Stats */}
          {!loading && data.contexts.length > 0 && (
            <div className="flex gap-4 text-right">
              <div>
                <p className="text-lg font-semibold text-stone-100">{data.contexts.length}</p>
                <p className="text-[10px] text-stone-600">Contexts</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-stone-100">{totalSignals}</p>
                <p className="text-[10px] text-stone-600">Signals</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-red-400">{counts.high}</p>
                <p className="text-[10px] text-stone-600">High risk</p>
              </div>
            </div>
          )}
        </div>

        {/* Filters */}
        {!loading && data.contexts.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-4">
            <div className="flex gap-1">
              {(["all", "high", "medium", "low"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRiskFilter(r)}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                    riskFilter === r
                      ? "bg-stone-800 text-stone-100"
                      : "text-stone-600 hover:text-stone-400"
                  }`}
                >
                  {r === "all" ? "All risk" : `${r.charAt(0).toUpperCase()}${r.slice(1)}`}
                  {r !== "all" && <span className="ml-1 text-stone-700">{counts[r]}</span>}
                </button>
              ))}
            </div>

            <div className="flex gap-1">
              {(
                [
                  { key: "all", label: "All" },
                  { key: "email_thread", label: "Mail" },
                  { key: "chat_conversation", label: "Threads" },
                  { key: "loose_commitment", label: "Commitments" },
                ] as const
              ).map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setKindFilter(key)}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                    kindFilter === key
                      ? "bg-stone-800 text-stone-100"
                      : "text-stone-600 hover:text-stone-400"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-28 animate-pulse rounded-xl border border-stone-800 bg-stone-900/30"
              />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <svg
              aria-hidden="true"
              className="mb-4 h-10 w-10 text-stone-700"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
            </svg>
            <p className="text-sm text-stone-500">
              {data.contexts.length === 0
                ? "No active work contexts detected."
                : "No contexts match the current filter."}
            </p>
            <p className="mt-1 text-[12px] text-stone-700">
              Work contexts are inferred from active mail threads, conversations, and commitments.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {visible.map((context) => (
              <ContextCard key={context.id} context={context} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function WorkGraphPage() {
  return (
    <AuthGuard>
      <WorkGraphContent />
    </AuthGuard>
  );
}
