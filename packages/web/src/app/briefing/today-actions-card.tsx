"use client";

/**
 * "What did Klorn do for me today?" card — five-line summary at the top of
 * /briefing showing executed actions, open proposals, rejections, and urgent
 * mail surfaced since UTC midnight. Backed by GET /api/automations/today-actions.
 */

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { apiFetch } from "../../lib/api";
import { useT } from "../../lib/i18n";
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
  const { t } = useT();
  const query = useQuery({
    queryKey: queryKeys.briefing.todayActions(),
    queryFn: () => apiFetch<TodayActionsResponse>("/api/automations/today-actions"),
    staleTime: 60_000,
  });

  if (query.isLoading) {
    return (
      <section className="panel-elevated mb-4 rounded-2xl border border-line/70 bg-surface-panel p-4">
        <p className="text-xs text-ink-dim">{t("todayActions.loading")}</p>
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
      <section className="panel-elevated mb-4 rounded-2xl border border-line/70 bg-surface-panel p-4">
        <header className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">{t("todayActions.title")}</h2>
          <span className="text-caption text-ink-dim">{t("todayActions.since")}</span>
        </header>
        <p className="text-xs text-ink-dim">{t("todayActions.idle")}</p>
      </section>
    );
  }

  return (
    <section className="panel-elevated mb-4 rounded-2xl border border-line/70 bg-surface-panel p-4">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">{t("todayActions.title")}</h2>
        <span className="text-caption text-ink-dim">{t("todayActions.since")}</span>
      </header>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <TodayStat
          label={t("todayActions.stat.executed")}
          value={data.totals.executed}
          tone={data.totals.executed > 0 ? "good" : "idle"}
        />
        <TodayStat
          label={t("todayActions.stat.pending")}
          value={data.totals.pending}
          tone={data.totals.pending > 0 ? "warn" : "idle"}
        />
        <TodayStat
          label={t("todayActions.stat.declined")}
          value={data.totals.rejected}
          tone="idle"
        />
        <TodayStat
          label={t("todayActions.stat.urgent")}
          value={data.totals.urgent}
          tone={data.totals.urgent > 0 ? "hot" : "idle"}
        />
      </div>

      <div className="mt-3 space-y-2">
        {data.executed.slice(0, 2).map((item) => (
          <TodayRow
            key={item.id}
            tone="executed"
            label={t("todayActions.row.executed")}
            tool={item.toolName}
            text={item.summary || t("todayActions.noSummary")}
          />
        ))}
        {data.pending.slice(0, 2).map((item) => (
          <TodayRow
            key={item.id}
            tone="pending"
            label={t("todayActions.row.pending")}
            tool={item.toolName}
            text={item.summary || t("todayActions.noSummary")}
            href="/inbox"
          />
        ))}
        {data.urgent.slice(0, 1).map((item) => (
          <TodayRow
            key={item.id}
            tone="urgent"
            label={t("todayActions.row.urgent")}
            text={item.message}
            href={item.link ?? undefined}
          />
        ))}
      </div>

      {data.totals.pending > 0 && (
        <div className="mt-3 border-t border-line pt-3">
          <Link
            href="/inbox"
            className="text-caption text-amber-300 transition hover:text-state-warn-ink"
          >
            {t("todayActions.seeAll", { count: String(data.totals.pending) })} →
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
    good: "border-emerald-400/30 bg-emerald-500/10 text-state-ok-ink",
    warn: "border-state-warn-line bg-amber-300/10 text-amber-100",
    hot: "border-rose-400/30 bg-rose-400/10 text-rose-100",
    idle: "border-line bg-surface-panel text-ink-mid",
  }[tone];
  return (
    <div className={`rounded-lg border px-2.5 py-2 ${toneClasses}`}>
      <p className="text-caption uppercase tracking-wider opacity-70">{label}</p>
      <p className="text-base font-semibold leading-none">{value}</p>
    </div>
  );
}

function TodayRow({
  tone,
  label,
  tool,
  text,
  href,
}: {
  tone: "executed" | "pending" | "urgent";
  label: string;
  tool?: string;
  text: string;
  href?: string;
}) {
  const dot = {
    executed: "bg-emerald-400",
    pending: "bg-amber-300",
    urgent: "bg-rose-400",
  }[tone];
  const inner = (
    <div className="flex items-start gap-2 rounded-lg border border-line bg-surface-raised px-3 py-2">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-caption font-medium text-ink-mid">
          <span className="opacity-60">{label}</span>
          {tool && (
            <>
              <span className="mx-1.5 opacity-40">·</span>
              <code className="text-ink-mid">{tool}</code>
            </>
          )}
        </p>
        <p className="mt-0.5 truncate text-xs leading-snug text-ink-mid">{text}</p>
      </div>
    </div>
  );
  return href ? (
    <Link href={href} className="block transition hover:[&>div]:border-line">
      {inner}
    </Link>
  ) : (
    inner
  );
}
