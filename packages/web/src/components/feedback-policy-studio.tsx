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
    <section className="mb-6 rounded-2xl border border-stone-800 bg-stone-950/50 p-4 md:p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent/80">
            Policy Studio
          </p>
          <h2 className="mt-2 text-lg font-semibold text-stone-100">
            Rules learned from repeated feedback
          </h2>
          <p className="mt-1 max-w-xl text-xs leading-5 text-stone-500">
            Apply or hide candidates from approve, reject, and edit patterns to tune Jigeum's
            suggestions.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="h-8 rounded-md border border-stone-700 px-3 text-xs text-stone-400 transition hover:border-accent/35 hover:text-stone-200 disabled:opacity-50"
        >
          {loading ? "Checking" : "Refresh"}
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
          There are not enough repeated feedback patterns yet. Rule candidates will appear here once
          correction logs build up.
        </p>
      )}

      {!loading && (
        <div className="space-y-2">
          {candidates.slice(0, 5).map((candidate) => (
            <article
              key={candidate.id}
              className="rounded-xl border border-stone-800 bg-stone-900/35 p-3 transition hover:border-accent/25 hover:bg-stone-900/55"
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <PolicyBadge kind={candidate.kind} />
                    {candidate.active && (
                      <span className="rounded border border-accent/20 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent-light">
                        Active
                      </span>
                    )}
                    {candidate.ignored && (
                      <span className="rounded border border-stone-700 px-1.5 py-0.5 text-[10px] text-stone-500">
                        Hidden
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
                    className="h-8 rounded-md border border-accent/25 bg-accent/10 px-3 text-xs font-medium text-accent-muted transition hover:bg-accent/15 disabled:opacity-50"
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreference(candidate, "IGNORED")}
                    disabled={updating === candidate.id}
                    className="h-8 rounded-md border border-stone-700 px-3 text-xs text-stone-400 transition hover:bg-stone-800 disabled:opacity-50"
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
    ALLOW_AFTER_SUGGESTION: ["Allow more often", "border-accent/20 bg-accent/10 text-accent-light"],
    REQUIRE_DRAFT_REVIEW: [
      "Keep draft review",
      "border-[#7DD3FC]/20 bg-[#7DD3FC]/10 text-[#7DD3FC]",
    ],
    AVOID_SUGGESTION: ["Suggest less", "border-red-400/20 bg-red-400/10 text-red-300"],
    LOWER_PRIORITY: ["Lower priority", "border-stone-700 bg-stone-800/40 text-stone-400"],
  }[kind];
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] ${meta[1]}`}>{meta[0]}</span>;
}
