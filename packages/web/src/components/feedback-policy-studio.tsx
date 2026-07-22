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
      setData(result);
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
    <section className="panel-elevated mb-6 rounded-2xl border border-slate-200/70 bg-white p-4 md:p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-600">
            Policy Studio
          </p>
          <h2 className="mt-2 text-lg font-semibold text-slate-900">
            Rules learned from repeated feedback
          </h2>
          <p className="mt-1 max-w-xl text-xs leading-5 text-slate-400">
            Apply or hide candidates from approve, reject, and edit patterns to tune Klorn's
            suggestions.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="ease-strong h-8 rounded-md border border-slate-200 bg-white/70 px-3 text-xs font-medium text-slate-500 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97] disabled:opacity-50"
        >
          {loading ? "Checking" : "Refresh"}
        </button>
      </div>

      {loading && (
        <div className="space-y-2">
          <div className="h-20 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
          <div className="h-20 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
        </div>
      )}

      {!loading && candidates.length === 0 && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-400">
          There are not enough repeated feedback patterns yet. Rule candidates will appear here once
          correction logs build up.
        </p>
      )}

      {!loading && (
        <div className="space-y-2">
          {candidates.slice(0, 5).map((candidate) => (
            <article
              key={candidate.id}
              className="row-wash ease-strong rounded-xl border border-slate-200 bg-white p-3 transition duration-150"
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <PolicyBadge kind={candidate.kind} />
                    {candidate.active && (
                      <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-emerald-600 ring-1 ring-inset ring-emerald-500/20">
                        Active
                      </span>
                    )}
                    {candidate.ignored && (
                      <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-slate-500 ring-1 ring-inset ring-slate-200">
                        Hidden
                      </span>
                    )}
                    <span className="text-[11px] tabular-nums text-slate-400">
                      {Math.round(candidate.confidence * 100)}%
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-slate-900">
                    {candidate.scope.toolName}
                    {candidate.scope.recipient ? ` · ${candidate.scope.recipient}` : ""}
                  </p>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-400">
                    {candidate.rationale}
                  </p>
                  <p className="mt-2 text-[11px] tabular-nums text-slate-500">
                    Approved {candidate.support.approved} · Rejected {candidate.support.rejected} ·
                    Edited {candidate.support.edited} · Failed {candidate.support.failed} · Total{" "}
                    {candidate.support.total}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2 md:flex-col">
                  <button
                    type="button"
                    onClick={() => setPreference(candidate, "ACTIVE")}
                    disabled={updating === candidate.id}
                    className="ease-strong h-8 rounded-md border border-sky-200 bg-sky-50 px-3 text-xs font-medium text-sky-700 transition duration-150 hover:bg-sky-100 active:scale-[0.97] disabled:opacity-50"
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreference(candidate, "IGNORED")}
                    disabled={updating === candidate.id}
                    className="ease-strong h-8 rounded-md border border-slate-200 bg-white/70 px-3 text-xs text-slate-500 transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97] disabled:opacity-50"
                  >
                    Hide
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function PolicyBadge({ kind }: { kind: PolicyKind }) {
  const meta = {
    ALLOW_AFTER_SUGGESTION: ["Allow more often", "bg-sky-500/10 text-sky-600 ring-sky-500/20"],
    REQUIRE_DRAFT_REVIEW: ["Keep draft review", "bg-slate-100 text-slate-500 ring-slate-200"],
    AVOID_SUGGESTION: ["Suggest less", "bg-rose-500/10 text-rose-600 ring-rose-500/20"],
    LOWER_PRIORITY: ["Lower priority", "bg-slate-100 text-slate-500 ring-slate-200"],
  }[kind];
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ring-1 ring-inset ${meta[1]}`}
    >
      {meta[0]}
    </span>
  );
}
