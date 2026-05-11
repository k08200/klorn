"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { EveSignalField } from "../../components/brand-visuals";
import { Markdown } from "../../components/markdown";
import { apiFetch } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { captureClientError } from "../../lib/sentry";

interface BriefingResponse {
  briefing: { id: string; content: string; createdAt: string } | null;
}

interface GenerateResponse {
  briefing: string;
  note?: { id: string; createdAt: string };
  notification?: { id: string; createdAt: string } | null;
}

type BriefingPushState =
  | "received"
  | "accepted"
  | "failed"
  | "skipped"
  | "pending"
  | "not_sent"
  | "no_subscription";

interface BriefingStatus {
  generated: boolean;
  notification: {
    id: string;
    title: string;
    message: string;
    createdAt: string;
  } | null;
  push: {
    state: BriefingPushState;
    reason: string | null;
    deliveryId: string | null;
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

type BriefingFeedbackChoice = "useful" | "wrong" | "later" | "done";

interface BriefingFeedbackResponse {
  feedback: Record<
    string,
    {
      id: string;
      rank: number;
      choice: BriefingFeedbackChoice;
      signal: string;
      evidence: string | null;
      createdAt: string;
    }
  >;
}

interface TopAction {
  rank: number;
  label: string;
}

const FEEDBACK_OPTIONS: Array<{ choice: BriefingFeedbackChoice; label: string }> = [
  { choice: "useful", label: "도움됨" },
  { choice: "wrong", label: "틀림" },
  { choice: "later", label: "나중에" },
  { choice: "done", label: "이미 처리" },
];

export default function BriefingPage() {
  return (
    <AuthGuard>
      <BriefingView />
    </AuthGuard>
  );
}

function BriefingView() {
  const { t } = useT();
  const [noteId, setNoteId] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<number, BriefingFeedbackChoice>>({});
  const [status, setStatus] = useState<BriefingStatus | null>(null);
  const [savingRank, setSavingRank] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFeedback = useCallback(async (id: string) => {
    try {
      const data = await apiFetch<BriefingFeedbackResponse>(
        `/api/briefing/${id}/top-actions/feedback`,
      );
      const next: Record<number, BriefingFeedbackChoice> = {};
      for (const [rank, row] of Object.entries(data.feedback)) {
        next[Number(rank)] = row.choice;
      }
      setFeedback(next);
    } catch (err) {
      captureClientError(err, { scope: "briefing.feedback.load", noteId: id });
      setFeedback({});
    }
  }, []);

  const loadToday = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, statusData] = await Promise.all([
        apiFetch<BriefingResponse>("/api/briefing/today"),
        apiFetch<BriefingStatus>("/api/briefing/status"),
      ]);
      setStatus(statusData);
      if (data.briefing) {
        setNoteId(data.briefing.id);
        setContent(data.briefing.content);
        setCreatedAt(data.briefing.createdAt);
        await loadFeedback(data.briefing.id);
      } else {
        setNoteId(null);
        setContent(null);
        setCreatedAt(null);
        setFeedback({});
      }
    } catch (err) {
      captureClientError(err, { scope: "briefing.load-today" });
      setError("브리핑을 불러오지 못했어요.");
    } finally {
      setLoading(false);
    }
  }, [loadFeedback]);

  useEffect(() => {
    loadToday();
  }, [loadToday]);

  const regenerate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const data = await apiFetch<GenerateResponse>("/api/briefing/generate", {
        method: "POST",
        body: JSON.stringify({}),
      });
      const statusData = await apiFetch<BriefingStatus>("/api/briefing/status");
      setContent(data.briefing);
      setNoteId(data.note?.id ?? null);
      setCreatedAt(data.note?.createdAt ?? new Date().toISOString());
      setStatus(statusData);
      setFeedback({});
    } catch (err) {
      captureClientError(err, { scope: "briefing.generate" });
      setError("생성 실패. 잠시 후 다시 시도해 주세요.");
    } finally {
      setGenerating(false);
    }
  };

  const submitFeedback = async (
    action: TopAction,
    choice: BriefingFeedbackChoice,
  ): Promise<void> => {
    if (!noteId || savingRank) return;
    setSavingRank(action.rank);
    setError(null);
    try {
      await apiFetch(`/api/briefing/${noteId}/top-actions/${action.rank}/feedback`, {
        method: "POST",
        body: JSON.stringify({ choice, label: action.label }),
      });
      setFeedback((prev) => ({ ...prev, [action.rank]: choice }));
    } catch (err) {
      captureClientError(err, {
        scope: "briefing.feedback.submit",
        noteId,
        rank: action.rank,
        choice,
      });
      setError("피드백 저장 실패. 잠시 후 다시 시도해 주세요.");
    } finally {
      setSavingRank(null);
    }
  };

  const formattedTime = createdAt
    ? new Date(createdAt).toLocaleTimeString("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  const topActions = content ? extractTopActions(content) : [];

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-28 pt-6 md:py-10">
      <header className="mb-6 overflow-hidden rounded-lg border border-stone-700/45 bg-stone-950/55 shadow-2xl shadow-black/10">
        <div className="h-1 bg-gradient-to-r from-amber-300 via-teal-300 to-stone-600" />
        <div className="grid gap-5 p-5 md:p-6 lg:grid-cols-[1fr_300px] lg:items-stretch">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300/80">
              결정 브리프
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-stone-50">
              오늘 처리할 결정만 압축
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-stone-500">
              메일, 일정, 할 일을 읽고 오늘 승인하거나 미뤄야 할 항목을 브리핑으로 정리합니다.
              {formattedTime && <span className="ml-2 text-stone-400">오늘 {formattedTime}</span>}
            </p>
          </div>
          <div className="relative min-h-40 overflow-hidden rounded-lg border border-stone-800 bg-black/20">
            <EveSignalField className="absolute inset-0 border-0" />
            <button
              type="button"
              onClick={regenerate}
              disabled={generating}
              className="absolute right-3 top-3 rounded-md border border-stone-700 bg-stone-950/75 px-3 py-1.5 text-xs text-stone-300 backdrop-blur transition hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-100 disabled:opacity-50"
            >
              {generating ? "생성 중..." : content ? "다시 생성" : "지금 생성"}
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2 lg:col-span-2">
            <BriefStat label="핵심 행동" value={topActions.length} />
            <BriefStat label="피드백" value={Object.keys(feedback).length} />
            <BriefStat label="상태" value={content ? "준비됨" : "비어 있음"} />
          </div>
        </div>
      </header>

      {status && <BriefingDeliveryStatus status={status} />}

      {loading && <p className="text-sm text-stone-500">로딩 중...</p>}

      {error && (
        <div className="rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {!loading && !error && !content && (
        <div className="rounded-lg border border-stone-700/45 bg-stone-950/35 p-6 text-center">
          <p className="mb-3 text-sm text-stone-300">아직 오늘의 브리핑이 없습니다.</p>
          <p className="mx-auto mb-4 max-w-md text-xs leading-5 text-amber-100/85">
            {t("briefing.learningMode")}
          </p>
          <p className="mb-4 text-xs text-stone-500">
            자동 브리핑 시간은{" "}
            <Link href="/settings" className="text-amber-300 hover:underline">
              설정
            </Link>
            에서 바꿀 수 있어요.
          </p>
          <button
            type="button"
            onClick={regenerate}
            disabled={generating}
            className="rounded-lg bg-amber-300 px-4 py-2 text-sm text-stone-950 transition hover:bg-amber-200 disabled:opacity-50"
          >
            {generating ? "생성 중..." : "지금 생성하기"}
          </button>
        </div>
      )}

      {content && (
        <div className="space-y-4">
          <article className="relative overflow-hidden rounded-lg border border-stone-700/45 bg-stone-950/35 p-5 pl-6 md:p-6 md:pl-7">
            <div className="absolute bottom-0 left-0 top-0 w-1 bg-gradient-to-b from-amber-300 via-teal-300 to-stone-700" />
            <Markdown content={content} />
          </article>

          {noteId && topActions.length > 0 && (
            <section className="rounded-lg border border-stone-700/45 bg-stone-950/35 p-4">
              <div className="mb-3">
                <h2 className="text-sm font-semibold text-stone-100">Top 3 피드백</h2>
                <p className="mt-1 text-xs text-stone-500">오늘 고른 항목이 맞았는지 기록해요.</p>
              </div>
              <div className="space-y-3">
                {topActions.map((action) => (
                  <div
                    key={action.rank}
                    className="rounded-lg border border-stone-700/45 bg-black/20 p-3"
                  >
                    <p className="text-sm text-stone-300">
                      <span className="text-stone-500">{action.rank}.</span> {action.label}
                    </p>
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {FEEDBACK_OPTIONS.map((option) => {
                        const selected = feedback[action.rank] === option.choice;
                        return (
                          <button
                            key={option.choice}
                            type="button"
                            onClick={() => submitFeedback(action, option.choice)}
                            aria-pressed={selected}
                            disabled={savingRank === action.rank}
                            className={`h-8 rounded-lg border px-2 text-xs transition disabled:opacity-50 ${
                              selected
                                ? "border-amber-300 bg-amber-500/10 text-amber-100"
                                : "border-stone-700 text-stone-400 hover:bg-stone-800"
                            }`}
                          >
                            {savingRank === action.rank && !selected ? "저장 중" : option.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function BriefingDeliveryStatus({ status }: { status: BriefingStatus }) {
  const push = pushStateCopy(status.push.state, status.push.reason);
  const auto = status.automation.enabled
    ? `${status.automation.briefingTime ?? "06:00"} · ${status.automation.timezone}`
    : status.automation.reason === "no_config"
      ? "설정 없음"
      : "꺼짐";
  const notification = status.notification
    ? new Date(status.notification.createdAt).toLocaleTimeString("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "아직 없음";

  return (
    <section className="mb-4 rounded-xl border border-stone-700/45 bg-stone-950/35 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-stone-100">브리핑 전달 상태</h2>
        <Link href="/settings" className="text-xs text-amber-300 hover:underline">
          설정
        </Link>
      </div>
      <div className="grid gap-2 text-xs sm:grid-cols-3">
        <DeliveryFact
          label="자동 브리핑"
          value={auto}
          tone={status.automation.enabled ? "ok" : "warn"}
        />
        <DeliveryFact
          label="앱 알림"
          value={notification}
          tone={status.notification ? "ok" : "muted"}
        />
        <DeliveryFact label="푸시" value={push.label} tone={push.tone} />
      </div>
      {push.reason && (
        <p className="mt-3 text-[11px] leading-5 text-stone-500">
          푸시 사유: {push.reason}. 브라우저 권한, 구독 상태, VAPID 키, 조용한 시간대 중 하나가 막고
          있을 수 있어요.
        </p>
      )}
    </section>
  );
}

function DeliveryFact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ok" | "warn" | "muted";
}) {
  const toneClass = {
    ok: "border-emerald-500/20 bg-emerald-500/5 text-emerald-200",
    warn: "border-amber-500/20 bg-amber-500/5 text-amber-200",
    muted: "border-stone-800 bg-black/15 text-stone-400",
  }[tone];
  return (
    <div className={`rounded-lg border px-3 py-2 ${toneClass}`}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] opacity-60">{label}</p>
      <p className="mt-1 truncate text-xs font-medium">{value}</p>
    </div>
  );
}

function pushStateCopy(
  state: BriefingPushState,
  reason: string | null,
): { label: string; tone: "ok" | "warn" | "muted"; reason: string | null } {
  switch (state) {
    case "received":
      return { label: "수신 확인", tone: "ok", reason };
    case "accepted":
      return { label: "전송됨", tone: "ok", reason };
    case "pending":
      return { label: "전송 대기", tone: "warn", reason };
    case "failed":
      return { label: "전송 실패", tone: "warn", reason };
    case "skipped":
      return { label: "전송 생략", tone: "warn", reason };
    case "not_sent":
      return { label: "아직 전송 안 됨", tone: "muted", reason };
    case "no_subscription":
      return { label: "브라우저 구독 없음", tone: "warn", reason: reason ?? "no_subscriptions" };
  }
}

function BriefStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-stone-700/45 bg-black/15 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-600">
        {label}
      </p>
      <p className="mt-1 truncate text-lg font-semibold text-stone-100">{value}</p>
    </div>
  );
}

function extractTopActions(content: string): TopAction[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const sectionIndex = normalized.search(/오늘의\s*Top\s*3|Top\s*3/i);
  const target = sectionIndex >= 0 ? normalized.slice(sectionIndex) : normalized;
  const actions: TopAction[] = [];
  const lineRegex = /^\s*(\d+)[.)]\s+(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = lineRegex.exec(target)) !== null && actions.length < 3) {
    const rank = Number.parseInt(match[1], 10);
    if (!Number.isInteger(rank) || rank < 1 || rank > 3) continue;
    const label = cleanActionLabel(match[2]);
    if (label) actions.push({ rank, label });
  }

  return actions;
}

function cleanActionLabel(value: string): string {
  return value
    .replace(/\*\*/g, "")
    .replace(/\s+[—-]\s+.+$/, "")
    .trim()
    .slice(0, 160);
}
