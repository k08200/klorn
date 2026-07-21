"use client";

/**
 * "What did Klorn do for me today?" card — five-line summary at the top of
 * /briefing showing executed actions, open proposals, rejections, and urgent
 * mail surfaced since UTC midnight. Backed by GET /api/automations/today-actions.
 */

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { apiFetch } from "../../lib/api";
import { queryKeys } from "../../lib/query-keys";

interface TodayActionsResponse {
  sinceUtc: string;
  executed: Array<{ id: string; toolName: string; summary: string; at: string }>;
  rejected: Array<{ id: string; toolName: string; reason: string; at: string }>;
  pending: Array<{
    id: string;
    toolName: string;
    summary: string;
    conversationId: string;
    at: string;
  }>;
  urgent: Array<{ id: string; message: string; link: string | null; at: string }>;
  totals: { executed: number; rejected: number; pending: number; urgent: number };
}

export function TodayActionsCard() {
  const query = useQuery({
    queryKey: queryKeys.briefing.todayActions(),
    queryFn: () => apiFetch<TodayActionsResponse>("/api/automations/today-actions"),
    staleTime: 60_000,
  });

  if (query.isLoading) {
    return (
      <section className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-xs text-slate-400">Loading today's activity…</p>
      </section>
    );
  }

  if (query.error || !query.data) return null;

  const data = query.data;
  const idle =
    data.totals.executed === 0 &&
    data.totals.rejected === 0 &&
    data.totals.pending === 0 &&
    data.totals.urgent === 0;

  if (idle) {
    return (
      <section className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
        <header className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">What Klorn did today</h2>
          <span className="text-[11px] text-slate-400">Since UTC midnight</span>
        </header>
        <p className="text-xs text-slate-400">
          Nothing to decide and nothing to run yet today. When a mail sync or decision card lands, a
          summary appears here.
        </p>
      </section>
    );
  }

  return (
    <section className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">What Klorn did today</h2>
        <span className="text-[11px] text-slate-400">Since UTC midnight</span>
      </header>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <TodayStat
          label="Auto-executed"
          value={data.totals.executed}
          tone={data.totals.executed > 0 ? "good" : "idle"}
        />
        <TodayStat
          label="Pending"
          value={data.totals.pending}
          tone={data.totals.pending > 0 ? "warn" : "idle"}
        />
        <TodayStat label="Declined" value={data.totals.rejected} tone="idle" />
        <TodayStat
          label="Urgent mail"
          value={data.totals.urgent}
          tone={data.totals.urgent > 0 ? "hot" : "idle"}
        />
      </div>

      <div className="mt-3 space-y-2">
        {data.executed.slice(0, 2).map((item) => (
          <TodayRow
            key={item.id}
            tone="executed"
            tool={item.toolName}
            text={item.summary || "No summary"}
          />
        ))}
        {data.pending.slice(0, 2).map((item) => (
          <TodayRow
            key={item.id}
            tone="pending"
            tool={item.toolName}
            text={item.summary || "No summary"}
            href="/inbox"
          />
        ))}
        {data.urgent.slice(0, 1).map((item) => (
          <TodayRow key={item.id} tone="urgent" text={item.message} href={item.link ?? undefined} />
        ))}
      </div>

      {data.totals.pending > 0 && (
        <div className="mt-3 border-t border-slate-200 pt-3">
          <Link
            href="/inbox"
            className="text-[11px] text-amber-300 transition hover:text-amber-200"
          >
            See all {data.totals.pending} pending decision{data.totals.pending === 1 ? "" : "s"} →
          </Link>
        </div>
      )}
    </section>
  );
}

function TodayStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "good" | "warn" | "hot" | "idle";
}) {
  const toneClasses = {
    good: "border-emerald-400/30 bg-emerald-500/10 text-emerald-200",
    warn: "border-amber-300/30 bg-amber-300/10 text-amber-100",
    hot: "border-rose-400/30 bg-rose-400/10 text-rose-100",
    idle: "border-slate-200 bg-white text-slate-500",
  }[tone];
  return (
    <div className={`rounded-lg border px-2.5 py-2 ${toneClasses}`}>
      <p className="text-[10px] uppercase tracking-wider opacity-70">{label}</p>
      <p className="text-base font-semibold leading-none">{value}</p>
    </div>
  );
}

function TodayRow({
  tone,
  tool,
  text,
  href,
}: {
  tone: "executed" | "pending" | "urgent";
  tool?: string;
  text: string;
  href?: string;
}) {
  const dot = {
    executed: "bg-emerald-400",
    pending: "bg-amber-300",
    urgent: "bg-rose-400",
  }[tone];
  const label = {
    executed: "Executed",
    pending: "Pending",
    urgent: "Urgent",
  }[tone];
  const inner = (
    <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium text-slate-500">
          <span className="opacity-60">{label}</span>
          {tool && (
            <>
              <span className="mx-1.5 opacity-40">·</span>
              <code className="text-slate-500">{tool}</code>
            </>
          )}
        </p>
        <p className="mt-0.5 truncate text-xs leading-snug text-slate-500">{text}</p>
      </div>
    </div>
  );
  return href ? (
    <Link href={href} className="block transition hover:[&>div]:border-slate-200">
      {inner}
    </Link>
  ) : (
    inner
  );
}
