"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
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
      const data = await apiFetch<BriefingResponse>("/api/briefing/today");
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
      setContent(data.briefing);
      setNoteId(data.note?.id ?? null);
      setCreatedAt(data.note?.createdAt ?? new Date().toISOString());
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
    <div className="mx-auto w-full max-w-2xl px-4 py-6 md:py-10">
      <header className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold text-gray-100">오늘의 브리핑</h1>
          {formattedTime && (
            <p className="text-xs text-gray-500 mt-1">오늘 {formattedTime}에 생성됨</p>
          )}
        </div>
        <button
          type="button"
          onClick={regenerate}
          disabled={generating}
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-50 transition"
        >
          {generating ? "생성 중..." : content ? "다시 생성" : "지금 생성"}
        </button>
      </header>

      {loading && <p className="text-sm text-gray-500">로딩 중...</p>}

      {error && (
        <div className="rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {!loading && !error && !content && (
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-6 text-center">
          <p className="text-sm text-gray-400 mb-3">아직 오늘의 브리핑이 없습니다.</p>
          <p className="mx-auto mb-4 max-w-md text-xs leading-5 text-cyan-200/90">
            {t("briefing.learningMode")}
          </p>
          <p className="text-xs text-gray-500 mb-4">
            자동 브리핑 시간은{" "}
            <Link href="/settings" className="text-cyan-400 hover:underline">
              설정
            </Link>
            에서 바꿀 수 있어요.
          </p>
          <button
            type="button"
            onClick={regenerate}
            disabled={generating}
            className="text-sm px-4 py-2 rounded-lg bg-white text-black hover:bg-gray-200 disabled:opacity-50 transition"
          >
            {generating ? "생성 중..." : "지금 생성하기"}
          </button>
        </div>
      )}

      {content && (
        <div className="space-y-4">
          <article className="rounded-xl border border-gray-800 bg-gray-900/40 p-5 md:p-6">
            <Markdown content={content} />
          </article>

          {noteId && topActions.length > 0 && (
            <section className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
              <div className="mb-3">
                <h2 className="text-sm font-semibold text-gray-100">Top 3 피드백</h2>
                <p className="mt-1 text-xs text-gray-500">오늘 고른 항목이 맞았는지 기록해요.</p>
              </div>
              <div className="space-y-3">
                {topActions.map((action) => (
                  <div
                    key={action.rank}
                    className="rounded-lg border border-gray-800 bg-black/20 p-3"
                  >
                    <p className="text-sm text-gray-300">
                      <span className="text-gray-500">{action.rank}.</span> {action.label}
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
                                ? "border-cyan-400 bg-cyan-400/10 text-cyan-200"
                                : "border-gray-700 text-gray-400 hover:bg-gray-800"
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
