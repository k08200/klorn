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

function normalizePlan(
  value: OperatingPlan | { plan?: Partial<OperatingPlan> | null },
): OperatingPlan {
  let raw: Partial<OperatingPlan> = EMPTY_PLAN;
  if (value && typeof value === "object" && "plan" in value) {
    raw = value.plan ?? EMPTY_PLAN;
  } else {
    raw = value as Partial<OperatingPlan>;
  }
  return {
    ...EMPTY_PLAN,
    ...raw,
    headline: raw.headline ?? "지금 흐름을 유지하면 됩니다.",
    primaryAction: raw.primaryAction ?? "가장 먼저 처리할 카드부터 확인하세요.",
    metrics: Array.isArray(raw.metrics) ? raw.metrics : [],
    nextMoves: Array.isArray(raw.nextMoves)
      ? raw.nextMoves.map((move, index) => normalizeMove(move, index))
      : [],
    watchlist: Array.isArray(raw.watchlist) ? raw.watchlist : [],
    playbookNudge: raw.playbookNudge ?? null,
    decisionPulse: {
      ...EMPTY_PLAN.decisionPulse,
      ...(raw.decisionPulse ?? {}),
      latest: Array.isArray(raw.decisionPulse?.latest)
        ? raw.decisionPulse.latest.map((outcome, index) => normalizeOutcome(outcome, index))
        : [],
    },
  };
}

function normalizeMove(move: Partial<OperatingPlanMove>, index: number): OperatingPlanMove {
  const legacy = move as Partial<OperatingPlanMove> & {
    priority?: "low" | "medium" | "high";
    rationale?: string;
    surface?: OperatingPlanMove["source"];
  };
  return {
    id: move.id ?? `move_${index}`,
    label: move.label ?? "다음 움직임",
    tone:
      move.tone ??
      (legacy.priority === "high" ? "critical" : legacy.priority === "medium" ? "warn" : "steady"),
    source: move.source ?? legacy.surface ?? "attention",
    title: move.title ?? "준비된 작업",
    reason: move.reason ?? legacy.rationale ?? "검토할 업무 신호가 있습니다.",
    prompt: move.prompt ?? move.title ?? "이 업무를 이어서 준비해줘",
    href: move.href ?? null,
  };
}

function normalizeOutcome(
  outcome: Partial<OperatingPlanOutcome>,
  index: number,
): OperatingPlanOutcome {
  return {
    id: outcome.id ?? `outcome_${index}`,
    title: outcome.title ?? "최근 결정",
    status: outcome.status ?? "executed",
    toolName: outcome.toolName ?? "decision",
    result: outcome.result ?? null,
    href: outcome.href ?? "/inbox",
    decidedAt: outcome.decidedAt ?? new Date().toISOString(),
  };
}

export default function OperatingLoopCard() {
  const [plan, setPlan] = useState<OperatingPlan>(EMPTY_PLAN);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await apiFetch<OperatingPlan | { plan?: Partial<OperatingPlan> | null }>(
        "/api/inbox/operating-plan",
      ).catch(() => EMPTY_PLAN);
      setPlan(normalizePlan(next));
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
            첫 움직임
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
                {plan.playbookNudge.active ? "적용 중" : "추천"} · 신뢰도{" "}
                {Math.round(plan.playbookNudge.confidence * 100)}%
                {plan.playbookNudge.nextStep ? ` · ${plan.playbookNudge.nextStep}` : ""}
              </p>
            </div>
          )}
          {plan.watchlist.length > 0 && (
            <div className="rounded-xl border border-stone-800 bg-stone-900/35 p-3">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-stone-500">
                관찰 목록
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
          <p className="mt-1 text-xs text-stone-500">최근 {pulse.windowHours}시간 결과</p>
        </div>
        <div className="shrink-0 text-right text-[11px] leading-5 text-stone-500">
          <p>
            완료 <span className="font-semibold text-emerald-200">{pulse.executed}</span>
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
        href={outcome.href ?? "/inbox"}
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
          {outcome.toolName && outcome.toolName !== "decision"
            ? outcome.toolName.replace(/_/g, " ")
            : "결정"}
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
        <ToneBadge tone={move.tone} label={displayText(move.label)} />
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
          스레드 준비
        </Link>
        {move.href && (
          <Link
            href={move.href}
            className="rounded-md border border-stone-700 px-2.5 py-1.5 text-xs text-stone-400 transition hover:bg-stone-800"
          >
            원문 보기
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
      <p className="mt-1 line-clamp-1 text-[11px] text-stone-600">{displayText(context.reason)}</p>
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
      <p className="mt-0.5 truncate text-[10px] text-stone-600">{displayText(metric.label)}</p>
    </div>
  );
}

function displayText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/EVE가/g, "Jigeum이")
    .replace(/Eve가/g, "Jigeum이")
    .replace(/EVE는/g, "Jigeum은")
    .replace(/Eve는/g, "Jigeum은")
    .replace(/\bEVE\b/g, "Jigeum")
    .replace(/\bEve\b/g, "Jigeum")
    .replace(
      /The Operating Loop picked "([^"]+)" as the next move\./g,
      '운영 루프가 "$1"을 다음 움직임으로 골랐어요.',
    )
    .replace(/Category:/g, "분류:")
    .replace(/Source:/g, "출처:")
    .replace(/Reason:/g, "근거:")
    .replace(/Source link:/g, "관련 위치:")
    .replace(
      /Turn this into an approval-ready decision card with any needed draft, checklist, and risk notes\./g,
      "이걸 실행 전 승인 가능한 결정 카드로 정리하고, 필요한 초안/체크리스트/리스크를 만들어줘.",
    )
    .replace(
      /Clear the decisions waiting for approval first\./g,
      "먼저 승인 대기 결정을 비우면 오늘 루프가 풀립니다.",
    )
    .replace(
      /Recover the work contexts that are drifting into risk\./g,
      "위험해진 업무 맥락을 먼저 회수해야 합니다.",
    )
    .replace(
      /The day is ordered around meetings and due work\./g,
      "오늘 일정과 마감 기준으로 실행 순서를 잡았습니다.",
    )
    .replace(
      /No major fires\. Clean up the open commitments quietly\./g,
      "큰 화재는 없고, 열린 약속을 조용히 정리할 차례입니다.",
    )
    .replace(
      /Jigeum will refresh the plan when new signals arrive\./g,
      "새 신호가 들어오면 Jigeum이 다시 운영 계획을 갱신합니다.",
    )
    .replace(/Start with the first decision card\./g, "상단 결정 카드부터 확인하세요.")
    .replace(
      /Multiple signals are tied to the same work context\./g,
      "여러 신호가 같은 업무 맥락으로 묶였습니다.",
    )
    .replace(/Recent activity and open signals are present\./g, "최근 활동과 열린 신호가 있습니다.")
    .replace(/Unread mail/g, "읽지 않은 메일")
    .replace(/Urgent mail/g, "긴급 메일")
    .replace(/Awaiting approval/g, "승인 대기")
    .replace(/Risk context/g, "위험 맥락")
    .replace(/Watch context/g, "관찰 맥락")
    .replace(/Overdue commitment/g, "지난 약속")
    .replace(/Open commitment/g, "열린 약속")
    .replace(/Recommended playbook/g, "추천 플레이북")
    .replace(/Active playbook/g, "활성 플레이북")
    .replace(/Decision proposal/g, "결정 제안")
    .replace(/Needs approval/g, "승인 필요")
    .replace(/Overdue work/g, "지난 일")
    .replace(/Today/g, "오늘")
    .replace(/Commitment/g, "약속")
    .replace(/^Decisions$/g, "결정")
    .replace(/Risk/g, "위험")
    .replace(/Overdue/g, "지난 항목");
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
      return "리스크 회복 모드";
    case "prepare_day":
      return "하루 준비 모드";
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
  if (status === "executed") return "완료";
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
