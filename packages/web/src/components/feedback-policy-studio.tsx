"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { captureClientError } from "../lib/sentry";

type PolicyKind =
  | "ALLOW_AFTER_SUGGESTION"
  | "REQUIRE_DRAFT_REVIEW"
  | "AVOID_SUGGESTION"
  | "LOWER_PRIORITY";

interface PolicyCandidate {
  id: string;
  kind: PolicyKind;
  confidence: number;
  rationale: string;
  active: boolean;
  ignored?: boolean;
  scope: {
    type: "RECIPIENT_TOOL" | "TOOL";
    toolName: string;
    recipient: string | null;
  };
  support: {
    approved: number;
    rejected: number;
    edited: number;
    ignored: number;
    snoozed: number;
    dismissed: number;
    failed: number;
    total: number;
  };
}

interface PolicyResponse {
  since: string;
  candidates: PolicyCandidate[];
}

export default function FeedbackPolicyStudio() {
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiFetch<PolicyResponse>("/api/feedback/policy-candidates?minEvents=2");
      setData({
        since: result.since ?? new Date().toISOString(),
        candidates: Array.isArray(result.candidates) ? result.candidates : [],
      });
    } catch (err) {
      captureClientError(err, { scope: "feedback-policy.load" });
      setData({ since: new Date().toISOString(), candidates: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setPreference = async (candidate: PolicyCandidate, action: "ACTIVE" | "IGNORED") => {
    if (updating) return;
    setUpdating(candidate.id);
    try {
      await apiFetch("/api/feedback/policy-preferences", {
        method: "POST",
        body: JSON.stringify({
          candidateId: candidate.id,
          kind: candidate.kind,
          toolName: candidate.scope.toolName,
          recipient: candidate.scope.recipient,
          action,
        }),
      });
      await load();
    } catch (err) {
      captureClientError(err, { scope: "feedback-policy.preference", candidateId: candidate.id });
    } finally {
      setUpdating(null);
    }
  };

  const candidates = data?.candidates ?? [];

  return (
    <section className="mb-6 rounded-2xl border border-stone-800 bg-stone-950/50 p-4 md:p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300/80">
            규칙 스튜디오
          </p>
          <h2 className="mt-2 text-lg font-semibold text-stone-100">반복 피드백으로 배운 규칙</h2>
          <p className="mt-1 max-w-xl text-xs leading-5 text-stone-500">
            승인, 거절, 수정 패턴에서 만들어진 규칙 후보를 적용하거나 숨깁니다.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="h-8 rounded-md border border-stone-700 px-3 text-xs text-stone-400 transition hover:border-amber-300/35 hover:text-stone-200 disabled:opacity-50"
        >
          {loading ? "확인 중" : "새로고침"}
        </button>
      </div>

      {loading && (
        <div className="space-y-2">
          <div className="h-20 animate-pulse rounded-lg border border-stone-800 bg-stone-900/45" />
          <div className="h-20 animate-pulse rounded-lg border border-stone-800 bg-stone-900/25" />
        </div>
      )}

      {!loading && candidates.length === 0 && (
        <p className="rounded-lg border border-stone-800 bg-black/20 p-3 text-xs text-stone-500">
          아직 반복 피드백 패턴이 충분하지 않아요. 교정 기록이 쌓이면 규칙 후보가 여기에 나타납니다.
        </p>
      )}

      {!loading && (
        <div className="space-y-2">
          {candidates.slice(0, 5).map((candidate) => {
            const support = candidate.support ?? {
              approved: 0,
              rejected: 0,
              edited: 0,
              ignored: 0,
              snoozed: 0,
              dismissed: 0,
              failed: 0,
              total: 0,
            };
            return (
              <article
                key={candidate.id}
                className="rounded-xl border border-stone-800 bg-stone-900/35 p-3 transition hover:border-amber-300/25 hover:bg-stone-900/55"
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <PolicyBadge kind={candidate.kind} />
                      {candidate.active && (
                        <span className="rounded border border-emerald-400/20 bg-emerald-400/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
                          적용 중
                        </span>
                      )}
                      {candidate.ignored && (
                        <span className="rounded border border-stone-700 px-1.5 py-0.5 text-[10px] text-stone-500">
                          숨김
                        </span>
                      )}
                      <span className="text-[11px] text-stone-500">
                        {Math.round(candidate.confidence * 100)}%
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-stone-200">
                      {candidate.scope.toolName}
                      {candidate.scope.recipient ? ` · ${candidate.scope.recipient}` : ""}
                    </p>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-stone-500">
                      {candidate.rationale}
                    </p>
                    <p className="mt-2 text-[11px] text-stone-600">
                      승인 {support.approved} · 거절 {support.rejected} · 수정 {support.edited} ·
                      실패 {support.failed} · 전체 {support.total}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2 md:flex-col">
                    <button
                      type="button"
                      onClick={() => setPreference(candidate, "ACTIVE")}
                      disabled={updating === candidate.id}
                      className="h-8 rounded-md border border-amber-300/25 bg-amber-300/10 px-3 text-xs font-medium text-amber-200 transition hover:bg-amber-300/15 disabled:opacity-50"
                    >
                      적용
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreference(candidate, "IGNORED")}
                      disabled={updating === candidate.id}
                      className="h-8 rounded-md border border-stone-700 px-3 text-xs text-stone-400 transition hover:bg-stone-800 disabled:opacity-50"
                    >
                      숨기기
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function PolicyBadge({ kind }: { kind: PolicyKind }) {
  const meta = {
    ALLOW_AFTER_SUGGESTION: [
      "신뢰도 높임",
      "border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
    ],
    REQUIRE_DRAFT_REVIEW: ["초안 검토 유지", "border-sky-400/20 bg-sky-400/10 text-sky-300"],
    AVOID_SUGGESTION: ["제안 줄이기", "border-red-400/20 bg-red-400/10 text-red-300"],
    LOWER_PRIORITY: ["우선순위 낮춤", "border-stone-700 bg-stone-800/40 text-stone-400"],
  }[kind];
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] ${meta[1]}`}>{meta[0]}</span>;
}
