"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../../lib/api";
import { captureClientError } from "../../../lib/sentry";

interface UsageStats {
  period: string;
  since: string;
  summary: {
    totalTokens: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalCost: number;
    messageCount: number;
  };
  daily: { date: string; tokens: number; cost: number; messages: number }[];
}

interface ConvUsage {
  conversationId: string;
  title: string;
  totalTokens: number;
  estimatedCost: number;
  messageCount: number;
}

export default function UsagePage() {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [convUsages, setConvUsages] = useState<ConvUsage[]>([]);
  const [period, setPeriod] = useState("month");

  useEffect(() => {
    apiFetch<UsageStats>(`/api/usage?period=${period}`)
      .then(setStats)
      .catch((err) => captureClientError(err, { scope: "usage.load-stats", period }));
    apiFetch<{ conversations: ConvUsage[] }>("/api/usage/conversations")
      .then((d) => setConvUsages(d.conversations))
      .catch((err) => captureClientError(err, { scope: "usage.load-conversations" }));
  }, [period]);

  const formatTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  };

  return (
    <div className="mx-auto max-w-3xl px-4 pb-28 pt-6 sm:px-6 md:py-10">
      <header className="mb-5 rounded-2xl border border-stone-700/45 bg-stone-950/35 p-5 shadow-2xl shadow-black/10">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300/80">
          Usage Ledger
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-stone-50">
          EVE 운영량과 추정 비용
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-stone-500">
          대화와 판단 생성에 쓰인 토큰을 기간별로 확인하고, 어떤 스레드가 비용을 만드는지
          추적합니다.
        </p>
      </header>

      {/* Period selector */}
      <div className="mb-6 flex gap-2">
        {[
          { value: "week", label: "This Week" },
          { value: "month", label: "This Month" },
          { value: "all", label: "All Time" },
        ].map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => setPeriod(p.value)}
            className={`rounded-full border px-3 py-1.5 text-xs transition ${
              period === p.value
                ? "border-amber-300 bg-amber-300 text-stone-950"
                : "border-stone-700/55 bg-stone-950/45 text-stone-400 hover:bg-stone-900/70 hover:text-stone-200"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {stats && (
        <>
          {/* Summary cards */}
          <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <UsageMetric label="Total Tokens" value={formatTokens(stats.summary.totalTokens)} />
            <UsageMetric label="Messages" value={String(stats.summary.messageCount)} />
            <UsageMetric label="Est. Cost" value={`$${stats.summary.totalCost.toFixed(4)}`} />
            <UsageMetric
              label="Avg/Message"
              value={
                stats.summary.messageCount > 0
                  ? formatTokens(Math.round(stats.summary.totalTokens / stats.summary.messageCount))
                  : "0"
              }
            />
          </div>

          {/* Daily breakdown */}
          {stats.daily.length > 0 && (
            <div className="mb-8">
              <h2 className="mb-3 text-sm font-medium text-stone-300">Daily Breakdown</h2>
              <div className="overflow-hidden rounded-xl border border-stone-700/45 bg-stone-950/35">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-stone-700/45 text-[11px] text-stone-500">
                      <th className="px-4 py-2 text-left font-medium">Date</th>
                      <th className="px-4 py-2 text-right font-medium">Messages</th>
                      <th className="px-4 py-2 text-right font-medium">Tokens</th>
                      <th className="px-4 py-2 text-right font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.daily.map((d) => (
                      <tr key={d.date} className="border-b border-stone-800/45 last:border-0">
                        <td className="px-4 py-2 text-stone-300">{d.date}</td>
                        <td className="px-4 py-2 text-right text-stone-400">{d.messages}</td>
                        <td className="px-4 py-2 text-right text-stone-400">
                          {formatTokens(d.tokens)}
                        </td>
                        <td className="px-4 py-2 text-right text-amber-200/85">
                          ${d.cost.toFixed(4)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Per-conversation usage */}
      {convUsages.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-medium text-stone-300">Top Conversations by Usage</h2>
          <div className="overflow-hidden rounded-xl border border-stone-700/45 bg-stone-950/35">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-700/45 text-[11px] text-stone-500">
                  <th className="px-4 py-2 text-left font-medium">Conversation</th>
                  <th className="px-4 py-2 text-right font-medium">Messages</th>
                  <th className="px-4 py-2 text-right font-medium">Tokens</th>
                  <th className="px-4 py-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {convUsages.map((c) => (
                  <tr key={c.conversationId} className="border-b border-stone-800/45 last:border-0">
                    <td className="max-w-[200px] truncate px-4 py-2 text-stone-300">{c.title}</td>
                    <td className="px-4 py-2 text-right text-stone-400">{c.messageCount}</td>
                    <td className="px-4 py-2 text-right text-stone-400">
                      {formatTokens(c.totalTokens)}
                    </td>
                    <td className="px-4 py-2 text-right text-amber-200/85">
                      ${c.estimatedCost.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!stats && (
        <div className="flex items-center justify-center py-20 text-stone-500">Loading...</div>
      )}
    </div>
  );
}

function UsageMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-stone-700/45 bg-stone-950/35 p-4">
      <p className="mb-1 text-[11px] text-stone-500">{label}</p>
      <p className="text-lg font-semibold text-stone-100">{value}</p>
    </div>
  );
}
