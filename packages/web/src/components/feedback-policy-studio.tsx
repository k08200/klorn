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
    <section className="panel-elevated mb-6 rounded-2xl border border-line/70 bg-surface-panel p-4 md:p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <p className="text-caption font-semibold uppercase tracking-[0.18em] text-accent-deep">
            Policy Studio
          </p>
          <h2 className="mt-2 text-lg font-semibold text-ink">
            Rules learned from repeated feedback
          </h2>
          <p className="mt-1 max-w-xl text-xs leading-5 text-ink-dim">
            Apply or hide candidates from approve, reject, and edit patterns to tune Klorn's
            suggestions.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="ease-strong h-8 rounded-md border border-line bg-surface-panel/70 px-3 text-xs font-medium text-ink-mid shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] disabled:opacity-50"
        >
          {loading ? "Checking" : "Refresh"}
        </button>
      </div>

      {loading && (
        <div className="space-y-2">
          <div className="h-20 animate-pulse rounded-lg border border-line bg-surface-hover" />
          <div className="h-20 animate-pulse rounded-lg border border-line bg-surface-hover" />
        </div>
      )}

      {!loading && candidates.length === 0 && (
        <p className="rounded-lg border border-line bg-surface-raised p-3 text-xs text-ink-dim">
          There are not enough repeated feedback patterns yet. Rule candidates will appear here once
          correction logs build up.
        </p>
      )}

      {!loading && (
        <div className="space-y-2">
          {candidates.slice(0, 5).map((candidate) => (
            <article
              key={candidate.id}
              className="row-wash ease-strong rounded-xl border border-line bg-surface-panel p-3 transition duration-150"
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <PolicyBadge kind={candidate.kind} />
                    {candidate.active && (
                      <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide text-state-ok-ink ring-1 ring-inset ring-emerald-500/20">
                        Active
                      </span>
                    )}
                    {candidate.ignored && (
                      <span className="rounded-md bg-surface-hover px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide text-ink-mid ring-1 ring-inset ring-line">
                        Hidden
                      </span>
                    )}
                    <span className="text-caption tabular-nums text-ink-dim">
                      {Math.round(candidate.confidence * 100)}%
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-ink">
                    {candidate.scope.toolName}
                    {candidate.scope.recipient ? ` · ${candidate.scope.recipient}` : ""}
                  </p>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-ink-dim">
                    {candidate.rationale}
                  </p>
                  <p className="mt-2 text-caption tabular-nums text-ink-mid">
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
                    className="ease-strong h-8 rounded-md border border-state-info-line bg-state-info-bg px-3 text-xs font-medium text-accent-deeper transition duration-150 hover:bg-accent-dim active:scale-[0.97] disabled:opacity-50"
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreference(candidate, "IGNORED")}
                    disabled={updating === candidate.id}
                    className="ease-strong h-8 rounded-md border border-line bg-surface-panel/70 px-3 text-xs text-ink-mid transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] disabled:opacity-50"
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
    ALLOW_AFTER_SUGGESTION: ["Allow more often", "bg-accent/10 text-accent-deep ring-accent/20"],
    REQUIRE_DRAFT_REVIEW: ["Keep draft review", "bg-surface-hover text-ink-mid ring-line"],
    AVOID_SUGGESTION: ["Suggest less", "bg-rose-500/10 text-rose-600 ring-rose-500/20"],
    LOWER_PRIORITY: ["Lower priority", "bg-surface-hover text-ink-mid ring-line"],
  }[kind];
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ring-inset ${meta[1]}`}
    >
      {meta[0]}
    </span>
  );
}
