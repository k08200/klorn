"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

interface RetentionMetrics {
  generatedAt: string;
  users: { total: number; new7d: number; new30d: number };
  active: { dau: number; wau: number; mau: number };
  retention: { d1: number | null; d7: number | null; d14: number | null };
  engagement: { queueActionsPerDay7d: number; pushOpenRate: number | null; muteRate: number };
  totals: Record<string, number>;
}

const pct = (v: number | null): string => (v === null ? "—" : `${Math.round(v * 100)}%`);

function Stat({
  label,
  value,
  hint,
  highlight,
}: {
  label: string;
  value: string;
  hint?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        highlight ? "border-sky-300 bg-sky-50" : "border-slate-200/70 bg-white"
      }`}
    >
      <div className="text-2xl font-semibold tracking-tight text-slate-900 tabular-nums">
        {value}
      </div>
      <div className="mt-1 text-xs font-medium text-slate-600">{label}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-slate-400">{hint}</div> : null}
    </div>
  );
}

export default function RetentionDashboard() {
  const [data, setData] = useState<RetentionMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<RetentionMetrics>("/api/admin/analytics")
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load"));
  }, []);

  return (
    <section className="panel-elevated rounded-2xl border border-slate-200/70 bg-white p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-slate-900">Retention (Phase 1)</h2>
        <span className="text-[11px] text-slate-400">
          {data ? `as of ${new Date(data.generatedAt).toLocaleString()}` : ""}
        </span>
      </div>

      {error ? (
        <p className="text-sm text-red-600">Could not load analytics: {error}</p>
      ) : !data ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="DAU" value={String(data.active.dau)} hint="opened today" />
            <Stat label="WAU" value={String(data.active.wau)} hint="last 7 days" />
            <Stat label="MAU" value={String(data.active.mau)} hint="last 30 days" />
            <Stat
              label="Total users"
              value={String(data.users.total)}
              hint={`+${data.users.new7d} this week`}
            />
          </div>

          <div className="mt-3 grid grid-cols-3 gap-3">
            <Stat label="D1 retention" value={pct(data.retention.d1)} hint="back after 1 day" />
            <Stat
              label="D7 retention · GATE"
              value={pct(data.retention.d7)}
              hint="launch when ≥ 40%"
              highlight
            />
            <Stat label="D14 retention" value={pct(data.retention.d14)} hint="back after 2 weeks" />
          </div>

          <div className="mt-3 grid grid-cols-3 gap-3">
            <Stat
              label="Queue actions / day"
              value={String(data.engagement.queueActionsPerDay7d)}
              hint="7-day avg"
            />
            <Stat
              label="PUSH open rate"
              value={pct(data.engagement.pushOpenRate)}
              hint="opened / delivered"
            />
            <Stat
              label="Mute rate"
              value={pct(data.engagement.muteRate)}
              hint="turned notifications off"
            />
          </div>

          <p className="mt-3 text-[11px] text-slate-400">
            Gate: don&apos;t public-launch until D7 ≥ 40% on real users. First-party events (own
            Postgres), no third-party tracker.
          </p>
        </>
      )}
    </section>
  );
}
