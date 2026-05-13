"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import { captureClientError } from "../lib/sentry";
import { RelativeTime } from "./relative-time";

type EmailPriority = "URGENT" | "NORMAL" | "LOW";

interface UserCorrectionFixture {
  id: string;
  capturedAt: string;
  from: string;
  subject: string;
  labels: string[];
  expectedSyncPriority: EmailPriority;
  capturedHeuristic: {
    priority: EmailPriority;
    reason: string | null;
    signals: string[];
  };
  note: string | null;
}

interface EmailFeedbackResponse {
  fixtures: UserCorrectionFixture[];
  count: number;
}

const PRIORITY_STYLES: Record<EmailPriority, string> = {
  URGENT: "text-red-300 bg-red-500/10 border-red-500/20",
  NORMAL: "text-amber-200 bg-amber-500/10 border-amber-500/20",
  LOW: "text-stone-300 bg-stone-500/10 border-stone-500/20",
};

function PriorityPill({ priority }: { priority: EmailPriority }) {
  const label = {
    URGENT: "긴급",
    NORMAL: "보통",
    LOW: "낮음",
  }[priority];

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${PRIORITY_STYLES[priority]}`}
    >
      {label}
    </span>
  );
}

export function EmailFeedbackList() {
  const [fixtures, setFixtures] = useState<UserCorrectionFixture[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<EmailFeedbackResponse>("/api/email/feedback?limit=50")
      .then((data) => {
        const nextFixtures = Array.isArray(data.fixtures) ? data.fixtures : [];
        setFixtures(nextFixtures);
        setCount(Number.isFinite(data.count) ? data.count : nextFixtures.length);
        setError(null);
      })
      .catch((err) => {
        captureClientError(err, { scope: "email-feedback.load" });
        setError("메일 교정 기록을 불러오지 못했어요.");
      })
      .finally(() => setLoading(false));
  }, []);

  const exportHref = useMemo(() => {
    if (fixtures.length === 0) return null;
    const blob = new Blob([JSON.stringify({ fixtures, count }, null, 2)], {
      type: "application/json",
    });
    return URL.createObjectURL(blob);
  }, [fixtures, count]);

  useEffect(() => {
    return () => {
      if (exportHref) URL.revokeObjectURL(exportHref);
    };
  }, [exportHref]);

  return (
    <div>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-stone-300">
            {loading ? "교정 기록 확인 중..." : `교정 ${count}개`}
          </p>
          <p className="mt-1 text-sm text-stone-500">
            교정 기록은 Jigeum이 메일 우선순위와 답장 의도를 더 정확히 판단하는 데 쓰입니다.
          </p>
        </div>
        {exportHref && (
          <a
            href={exportHref}
            download="jigeum-email-feedback-fixtures.json"
            className="inline-flex w-fit items-center rounded-lg border border-stone-700/60 bg-stone-950/45 px-3 py-2 text-sm font-medium text-stone-200 transition hover:border-amber-500/35 hover:bg-amber-500/10"
          >
            JSON 내보내기
          </a>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-red-900/50 bg-red-950/20 p-4 text-sm text-red-300">
          메일 교정 기록을 불러오지 못했어요.
        </div>
      )}

      {loading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-xl border border-stone-700/45 bg-stone-950/35"
            />
          ))}
        </div>
      )}

      {!loading && !error && fixtures.length === 0 && (
        <div className="rounded-xl border border-stone-700/45 bg-stone-950/35 px-5 py-10 text-center">
          <p className="text-sm font-medium text-stone-300">아직 교정된 분류가 없어요.</p>
          <p className="mt-2 text-sm text-stone-500">
            메일 화면에서 분류가 틀렸다고 표시하면 여기에서 다시 확인할 수 있어요.
          </p>
        </div>
      )}

      {!loading && fixtures.length > 0 && (
        <div className="space-y-3">
          {fixtures.map((fixture) => (
            <div
              key={fixture.id}
              className="rounded-xl border border-stone-700/45 bg-stone-950/35 p-4 transition hover:border-amber-500/30 hover:bg-amber-500/5"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-stone-200">{fixture.subject}</p>
                  <p className="mt-1 truncate text-xs text-stone-500">{fixture.from}</p>
                </div>
                <RelativeTime
                  date={fixture.capturedAt}
                  className="shrink-0 text-xs text-stone-600"
                />
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <PriorityPill priority={fixture.capturedHeuristic.priority} />
                <span className="text-xs text-stone-600">-&gt;</span>
                <PriorityPill priority={fixture.expectedSyncPriority} />
                {fixture.capturedHeuristic.reason && (
                  <span className="rounded-full border border-stone-700/45 bg-black/15 px-2 py-0.5 text-[10px] text-stone-500">
                    {fixture.capturedHeuristic.reason}
                  </span>
                )}
              </div>

              {(fixture.capturedHeuristic.signals?.length ?? 0) > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {fixture.capturedHeuristic.signals.slice(0, 6).map((signal) => (
                    <span
                      key={signal}
                      className="max-w-full truncate rounded-md border border-stone-700/45 bg-black/15 px-2 py-1 text-[11px] text-stone-500"
                    >
                      {signal}
                    </span>
                  ))}
                </div>
              )}

              {fixture.note && <p className="mt-3 text-xs text-stone-500">{fixture.note}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
