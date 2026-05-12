"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import type {
  OperatingPlan,
  OperatingPlanDecisionPulse,
  OperatingPlanMetric,
  OperatingPlanMove,
  OperatingPlanOutcome,
  OperatingPlanTone,
  OperatingPlanWatchContext,
} from "../lib/operating-plan";

const EMPTY_PLAN: OperatingPlan = {
  generatedAt: "",
  mode: "maintain_flow",
  headline: "",
  primaryAction: "",
  metrics: [],
  nextMoves: [],
  watchlist: [],
  playbookNudge: null,
  decisionPulse: { windowHours: 24, executed: 0, rejected: 0, failed: 0, latest: [] },
};

export default function OperatingLoopCard() {
  const [plan, setPlan] = useState<OperatingPlan>(EMPTY_PLAN);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await apiFetch<OperatingPlan>("/api/inbox/operating-plan").catch(
        () => EMPTY_PLAN,
      );
      setPlan(next);
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

  if (loading && plan.metrics.length === 0) return null;
  if (!plan.headline && plan.nextMoves.length === 0 && plan.watchlist.length === 0) return null;

  return (
    <section
      className="mb-6 overflow-hidden rounded-2xl border border-amber-300/15 bg-stone-950/70"
      aria-label="Jigeum 운영 루프"
    >
      <div className="border-b border-stone-800 bg-gradient-to-br from-stone-950 via-stone-950 to-amber-950/25 p-4 md:p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300">
              운영 루프
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-stone-50">
              {modeLabel(plan.mode)}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-400">
              {displayText(plan.headline)}
            </p>
          </div>
          <div className="grid grid-cols-4 overflow-hidden rounded-xl border border-white/10 bg-black/20 md:min-w-[320px]">
            {plan.metrics.map((metric) => (
              <LoopMetric key={metric.label} metric={metric} />
            ))}
          </div>
        </div>
        <div className="mt-4 rounded-xl border border-stone-800 bg-black/20 px-3 py-2.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-stone-500">
            먼저 할 일
          </p>
          <p className="mt-1 text-sm font-medium text-amber-100">
            {displayText(plan.primaryAction)}
          </p>
        </div>
      </div>

      <div className="grid gap-3 p-3 md:grid-cols-[1.4fr_1fr] md:p-4">
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-stone-100">다음 움직임</h3>
            <span className="text-[11px] text-stone-600">{plan.nextMoves.length}</span>
          </div>
          <ul className="space-y-2">
            {plan.nextMoves.map((move) => (
              <li key={move.id}>
                <MoveRow move={move} />
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-3">
          {plan.decisionPulse.latest.length > 0 && <DecisionPulseCard pulse={plan.decisionPulse} />}
          {plan.playbookNudge && (
            <div className="rounded-xl border border-stone-800 bg-stone-900/35 p-3">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-amber-200">
                플레이북
              </p>
              <p className="mt-2 text-sm font-medium text-stone-100">{plan.playbookNudge.name}</p>
              <p className="mt-1 text-xs leading-5 text-stone-500">
                {plan.playbookNudge.active ? "활성화됨" : "추천됨"} · 신뢰도{" "}
                {Math.round(plan.playbookNudge.confidence * 100)}%
                {plan.playbookNudge.nextStep ? ` · ${plan.playbookNudge.nextStep}` : ""}
              </p>
            </div>
          )}
          {plan.watchlist.length > 0 && (
            <div className="rounded-xl border border-stone-800 bg-stone-900/35 p-3">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-stone-500">
                워치리스트
              </p>
              <ul className="mt-2 space-y-2">
                {plan.watchlist.map((context) => (
                  <WatchRow key={context.id} context={context} />
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function DecisionPulseCard({ pulse }: { pulse: OperatingPlanDecisionPulse }) {
  return (
    <div className="rounded-xl border border-stone-800 bg-stone-900/35 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-emerald-200">
            최근 결정
          </p>
          <p className="mt-1 text-xs text-stone-500">{pulse.windowHours}시간 결과</p>
        </div>
        <div className="shrink-0 text-right text-[11px] leading-5 text-stone-500">
          <p>
            실행 <span className="font-semibold text-emerald-200">{pulse.executed}</span>
          </p>
          <p>
            거절 <span className="font-semibold text-stone-300">{pulse.rejected}</span> · 실패{" "}
            <span className="font-semibold text-red-200">{pulse.failed}</span>
          </p>
        </div>
      </div>
      <ul className="mt-3 space-y-2">
        {pulse.latest.map((outcome) => (
          <DecisionOutcomeRow key={outcome.id} outcome={outcome} />
        ))}
      </ul>
    </div>
  );
}

function DecisionOutcomeRow({ outcome }: { outcome: OperatingPlanOutcome }) {
  return (
    <li>
      <Link
        href={outcome.href}
        className="block rounded-lg border border-stone-800/80 bg-black/20 px-2.5 py-2 transition hover:border-emerald-300/25 hover:bg-stone-900/60"
      >
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-xs font-medium text-stone-300">
            {displayText(outcome.title)}
          </p>
          <span className={`shrink-0 text-[10px] ${outcomeStatusClass(outcome.status)}`}>
            {outcomeStatusLabel(outcome.status)}
          </span>
        </div>
        <p className="mt-1 truncate text-[11px] text-stone-600">
          {outcome.toolName.replace(/_/g, " ")}
          {outcome.result ? ` · ${outcome.result}` : ""}
        </p>
      </Link>
    </li>
  );
}

function MoveRow({ move }: { move: OperatingPlanMove }) {
  const chatHref = `/chat?prefill=${encodeURIComponent(displayText(move.prompt))}`;
  const body = (
    <article className="rounded-xl border border-stone-800 bg-stone-900/35 p-3 transition hover:border-amber-300/25 hover:bg-stone-900/55">
      <div className="flex flex-wrap items-center gap-2">
        <ToneBadge tone={move.tone} label={move.label} />
        <span className="text-[11px] text-stone-600">{sourceLabel(move.source)}</span>
      </div>
      {move.href ? (
        <Link
          href={move.href}
          className="mt-2 block break-words text-sm font-medium text-stone-100"
        >
          {displayText(move.title)}
        </Link>
      ) : (
        <p className="mt-2 break-words text-sm font-medium text-stone-100">
          {displayText(move.title)}
        </p>
      )}
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-stone-500">
        {displayText(move.reason)}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          href={chatHref}
          className="rounded-md border border-amber-300/25 bg-amber-300/10 px-2.5 py-1.5 text-xs font-medium text-amber-100 transition hover:bg-amber-300/15"
        >
          스레드로 준비
        </Link>
        {move.href && (
          <Link
            href={move.href}
            className="rounded-md border border-stone-700 px-2.5 py-1.5 text-xs text-stone-400 transition hover:bg-stone-800"
          >
            원본 보기
          </Link>
        )}
      </div>
    </article>
  );
  return body;
}

function WatchRow({ context }: { context: OperatingPlanWatchContext }) {
  const body = (
    <div className="rounded-lg border border-stone-800/80 bg-black/20 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-xs font-medium text-stone-300">
          {displayText(context.title)}
        </p>
        <span className="shrink-0 text-[10px] text-stone-600">{riskLabel(context.risk)}</span>
      </div>
      <p className="mt-1 line-clamp-1 text-[11px] text-stone-600">
        {displayText(context.reason)}
      </p>
    </div>
  );
  return context.href ? (
    <li>
      <Link href={context.href} className="block">
        {body}
      </Link>
    </li>
  ) : (
    <li>{body}</li>
  );
}

function LoopMetric({ metric }: { metric: OperatingPlanMetric }) {
  return (
    <div className="border-r border-white/10 px-2 py-2 last:border-r-0">
      <p className={`text-lg font-semibold ${metricColor(metric.tone)}`}>{metric.value}</p>
      <p className="mt-0.5 truncate text-[10px] text-stone-600">{metric.label}</p>
    </div>
  );
}

function displayText(value: string): string {
  return value
    .replace(/EVE가/g, "Jigeum이")
    .replace(/Eve가/g, "Jigeum이")
    .replace(/EVE는/g, "Jigeum은")
    .replace(/Eve는/g, "Jigeum은")
    .replace(/\bEVE\b/g, "Jigeum")
    .replace(/\bEve\b/g, "Jigeum");
}

function ToneBadge({ tone, label }: { tone: OperatingPlanTone; label: string }) {
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${toneClass(tone)}`}>
      {label}
    </span>
  );
}

function modeLabel(mode: OperatingPlan["mode"]): string {
  switch (mode) {
    case "clear_decisions":
      return "결정 정리 모드";
    case "recover_risk":
      return "리스크 회수 모드";
    case "prepare_day":
      return "오늘 준비 모드";
    case "maintain_flow":
      return "흐름 유지 모드";
  }
}

function sourceLabel(source: OperatingPlanMove["source"]): string {
  switch (source) {
    case "attention":
      return "결정 카드";
    case "work_context":
      return "업무 그래프";
    case "playbook":
      return "플레이북";
  }
}

function riskLabel(risk: OperatingPlanWatchContext["risk"]): string {
  if (risk === "high") return "높음";
  if (risk === "medium") return "보통";
  return "낮음";
}

function outcomeStatusLabel(status: OperatingPlanOutcome["status"]): string {
  if (status === "executed") return "실행";
  if (status === "rejected") return "거절";
  return "실패";
}

function outcomeStatusClass(status: OperatingPlanOutcome["status"]): string {
  if (status === "executed") return "text-emerald-300";
  if (status === "rejected") return "text-stone-500";
  return "text-red-300";
}

function toneClass(tone: OperatingPlanTone): string {
  if (tone === "critical") return "border-red-500/25 bg-red-500/10 text-red-200";
  if (tone === "warn") return "border-amber-300/25 bg-amber-300/10 text-amber-200";
  return "border-stone-700 bg-stone-900 text-stone-300";
}

function metricColor(tone: OperatingPlanTone): string {
  if (tone === "critical") return "text-red-200";
  if (tone === "warn") return "text-amber-200";
  return "text-stone-100";
}
