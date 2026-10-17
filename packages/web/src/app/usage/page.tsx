"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { PAGE_SHELL } from "../../components/page-shell";
import EmptyState from "../../components/ui/empty-state";
import ErrorAlert from "../../components/ui/error-alert";
import LoadingState from "../../components/ui/loading-state";
import ResponsiveTable from "../../components/ui/responsive-table";
import Tabs from "../../components/ui/tabs";
import { apiFetch } from "../../lib/api";
import { useT } from "../../lib/i18n";

type UsagePeriod = "week" | "month" | "all";

interface UsageSummary {
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCost: number;
  messageCount: number;
}

interface DailyUsage {
  date: string;
  tokens: number;
  cost: number;
  messages: number;
}

interface UsageResponse {
  period: UsagePeriod;
  since: string;
  summary: UsageSummary;
  daily: DailyUsage[];
}

interface ConversationUsage {
  conversationId: string;
  title: string;
  totalTokens: number;
  estimatedCost: number;
  messageCount: number;
}

// Translation keys only — resolved via t() at render time, since this is a
// module-level constant outside the component (hooks rule).
const PERIOD_TAB_KEYS = [
  { id: "week", labelKey: "usage.period.week" },
  { id: "month", labelKey: "usage.period.month" },
  { id: "all", labelKey: "usage.period.all" },
];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

/** Same convention as /billing: sub-cent spend reads "< $0.01", not $0.0001. */
function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "< $0.01";
  return `$${amount.toFixed(2)}`;
}

function formatDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function StatTile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="panel-elevated rounded-2xl border border-line/70 bg-surface-panel p-5">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-ink-dim">{label}</p>
      <p className="mt-2 text-[26px] font-semibold leading-none tracking-[-0.02em] text-ink tabular-nums">
        {value}
      </p>
      {detail && <p className="mt-2 text-xs text-ink-mid tabular-nums">{detail}</p>}
    </div>
  );
}

function DailyActivity({ daily }: { daily: DailyUsage[] }) {
  const { t } = useT();
  const maxTokens = Math.max(...daily.map((d) => d.tokens), 1);
  return (
    <div className="panel-elevated rounded-2xl border border-line/70 bg-surface-panel p-5">
      <h2 className="text-sm font-semibold text-ink">{t("usage.dailyActivity.title")}</h2>
      <p className="mt-1 text-xs text-ink-mid">{t("usage.dailyActivity.subtitle")}</p>
      <ul className="mt-4 space-y-1">
        {daily.map((d) => (
          <li
            key={d.date}
            className="grid grid-cols-[64px_1fr_72px_64px] items-center gap-3 rounded-md px-2 py-1.5 text-xs transition hover:bg-surface-raised"
          >
            <span className="text-ink-mid">{formatDay(d.date)}</span>
            <span className="h-2 overflow-hidden rounded-full bg-surface-hover">
              <span
                className="block h-full rounded-full bg-accent"
                style={{ width: `${Math.max((d.tokens / maxTokens) * 100, 1.5)}%` }}
              />
            </span>
            <span className="text-right text-ink tabular-nums">{formatTokens(d.tokens)}</span>
            <span className="text-right text-ink-mid tabular-nums">{formatUsd(d.cost)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConversationsTable({ conversations }: { conversations: ConversationUsage[] }) {
  const { t } = useT();
  return (
    <div className="panel-elevated rounded-2xl border border-line/70 bg-surface-panel p-5">
      <h2 className="text-sm font-semibold text-ink">{t("usage.conversations.title")}</h2>
      <p className="mt-1 text-xs text-ink-mid">{t("usage.conversations.subtitle")}</p>
      <ResponsiveTable className="mt-4">
        <table className="min-w-[520px] w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line text-xs text-ink-dim">
              <th scope="col" className="py-2 pr-4 font-medium">
                {t("usage.conversations.colConversation")}
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                {t("usage.conversations.colMessages")}
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                {t("usage.conversations.colTokens")}
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                {t("usage.conversations.colEstCost")}
              </th>
            </tr>
          </thead>
          <tbody>
            {conversations.map((c) => (
              <tr key={c.conversationId} className="border-b border-line-soft last:border-0">
                <td className="max-w-[280px] truncate py-2 pr-4 text-ink">
                  {c.title || t("usage.conversations.untitled")}
                </td>
                <td className="py-2 pr-4 text-right text-ink-mid tabular-nums">{c.messageCount}</td>
                <td className="py-2 pr-4 text-right text-ink tabular-nums">
                  {formatTokens(c.totalTokens)}
                </td>
                <td className="py-2 text-right text-ink-mid tabular-nums">
                  {formatUsd(c.estimatedCost)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTable>
    </div>
  );
}

function UsageView() {
  const { t } = useT();
  const [period, setPeriod] = useState<UsagePeriod>("month");
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [conversations, setConversations] = useState<ConversationUsage[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (p: UsagePeriod) => {
      setLoading(true);
      setError(null);
      try {
        const [u, c] = await Promise.all([
          apiFetch<UsageResponse>(`/api/usage?period=${p}`),
          apiFetch<{ conversations: ConversationUsage[] }>("/api/usage/conversations"),
        ]);
        setUsage(u);
        setConversations(c.conversations);
      } catch {
        setError(t("usage.error.load"));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    load(period);
  }, [load, period]);

  const summary = usage?.summary;
  const hasActivity = (summary?.messageCount ?? 0) > 0;

  const periodTabs = PERIOD_TAB_KEYS.map((tab) => ({ id: tab.id, label: t(tab.labelKey) }));

  return (
    <div className={PAGE_SHELL}>
      <header className="mb-6">
        <h1 className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-ink">
          {t("usage.title")}
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-ink-mid">
          {t("usage.subtitlePre")}{" "}
          <Link href="/billing" className="focus-ring rounded text-accent-deep hover:underline">
            {t("usage.subtitleLinkLabel")}
          </Link>
          {t("usage.subtitlePost")}
        </p>
      </header>

      <div className="mb-6">
        <Tabs
          tabs={periodTabs}
          active={period}
          onChange={(id) => setPeriod(id as UsagePeriod)}
          ariaLabel={t("usage.period.ariaLabel")}
        />
      </div>

      {error && (
        <ErrorAlert className="mb-6" onRetry={() => load(period)}>
          {error}
        </ErrorAlert>
      )}

      {loading && <LoadingState rows={3} />}

      {!loading && !error && summary && !hasActivity && (
        <div className="panel-elevated rounded-2xl border border-line/70 bg-surface-panel">
          <EmptyState title={t("usage.empty.title")} description={t("usage.empty.description")} />
        </div>
      )}

      {!loading && !error && summary && hasActivity && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <StatTile label={t("usage.stat.estimatedCost")} value={formatUsd(summary.totalCost)} />
            <StatTile
              label={t("usage.stat.tokens")}
              value={formatTokens(summary.totalTokens)}
              detail={t("usage.stat.tokensDetail", {
                prompt: formatTokens(summary.totalPromptTokens),
                completion: formatTokens(summary.totalCompletionTokens),
              })}
            />
            <StatTile label={t("usage.stat.messages")} value={String(summary.messageCount)} />
          </div>

          {usage && usage.daily.length > 0 && <DailyActivity daily={usage.daily} />}

          {conversations && conversations.length > 0 && (
            <ConversationsTable conversations={conversations} />
          )}
        </div>
      )}
    </div>
  );
}

export default function UsagePage() {
  return (
    <AuthGuard>
      <UsageView />
    </AuthGuard>
  );
}
