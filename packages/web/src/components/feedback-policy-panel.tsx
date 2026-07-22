"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { captureClientError } from "../lib/sentry";
import Button from "./ui/button";

type FeedbackPolicyKind =
  | "ALLOW_AFTER_SUGGESTION"
  | "REQUIRE_DRAFT_REVIEW"
  | "AVOID_SUGGESTION"
  | "LOWER_PRIORITY";

interface FeedbackPolicyCandidate {
  id: string;
  kind: FeedbackPolicyKind;
  scope: {
    type: "RECIPIENT_TOOL" | "TOOL";
    toolName: string;
    recipient: string | null;
  };
  confidence: number;
  support: {
    approved: number;
    rejected: number;
    edited: number;
    ignored: number;
    snoozed: number;
    dismissed: number;
    failed: number;
    total: number;
    distinctRecipients: number;
  };
  rationale: string;
  active: false;
}

interface FeedbackPolicyResponse {
  since: string;
  candidates: FeedbackPolicyCandidate[];
}

const KIND_COPY: Record<
  FeedbackPolicyKind,
  { label: string; tone: string; dot: string; summary: string }
> = {
  ALLOW_AFTER_SUGGESTION: {
    label: "Repeated approvals",
    tone: "bg-sky-500/10 text-sky-600 ring-sky-500/20",
    dot: "bg-sky-500",
    summary: "Suggest with more confidence",
  },
  REQUIRE_DRAFT_REVIEW: {
    label: "Keep review",
    tone: "bg-slate-100 text-slate-500 ring-slate-200",
    dot: "bg-slate-400",
    summary: "Review drafts before running",
  },
  AVOID_SUGGESTION: {
    label: "Repeated rejects",
    tone: "bg-rose-500/10 text-rose-600 ring-rose-500/20",
    dot: "bg-rose-500",
    summary: "Suggest less often",
  },
  LOWER_PRIORITY: {
    label: "Lower priority",
    tone: "bg-slate-100 text-slate-500 ring-slate-200",
    dot: "bg-slate-400",
    summary: "Watch quietly",
  },
};

export function FeedbackPolicyPanel() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [since, setSince] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<FeedbackPolicyCandidate[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const data = await apiFetch<FeedbackPolicyResponse>(
        "/api/feedback/policy-candidates?limit=500&minEvents=3",
      );
      setSince(data.since);
      setCandidates(data.candidates);
    } catch (err) {
      setError(true);
      setCandidates([]);
      captureClientError(err, { scope: "settings.feedback-policy-candidates" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="panel-elevated rounded-2xl border border-slate-200/70 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">Learned operating signals</h3>
          <p className="mt-0.5 text-xs text-slate-400">
            {since
              ? `Since ${new Date(since).toLocaleDateString("en-US")}`
              : "Recent feedback patterns"}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          loading={loading}
        >
          Refresh
        </Button>
      </div>

      {loading ? (
        <div className="mt-4 space-y-2">
          <div className="h-16 animate-pulse rounded-lg bg-slate-100" />
          <div className="h-16 animate-pulse rounded-lg bg-slate-100" />
        </div>
      ) : error ? (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          Could not load operating signals.
        </div>
      ) : candidates.length === 0 ? (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-400">
          No stable operating signals yet.
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {candidates.slice(0, 6).map((candidate) => {
            const copy = KIND_COPY[candidate.kind];
            return (
              <div
                key={candidate.id}
                className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${copy.dot}`} />
                      <span className="break-words font-mono text-xs text-slate-900">
                        {candidate.scope.toolName}
                      </span>
                      {candidate.scope.recipient && (
                        <span className="break-all text-xs text-slate-400">
                          {candidate.scope.recipient}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-slate-400">{copy.summary}</p>
                  </div>
                  <span
                    className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ring-1 ring-inset ${copy.tone}`}
                  >
                    {copy.label}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-[10px] text-slate-400 sm:grid-cols-6">
                  <SignalCount label="Approved" value={candidate.support.approved} />
                  <SignalCount label="Rejected" value={candidate.support.rejected} />
                  <SignalCount label="Edited" value={candidate.support.edited} />
                  <SignalCount label="Failed" value={candidate.support.failed} tone="critical" />
                  <SignalCount label="Ignored" value={candidate.support.ignored} />
                  <SignalCount label="Snoozed" value={candidate.support.snoozed} />
                  <SignalCount label="Closed" value={candidate.support.dismissed} />
                </div>
                <div className="mt-2 flex items-center justify-between text-[10px] tabular-nums text-slate-500">
                  <span>Confidence {Math.round(candidate.confidence * 100)}%</span>
                  <span>{candidate.support.total} events</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SignalCount({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "critical";
}) {
  return (
    <div className="rounded-md bg-slate-100 px-2 py-1">
      <div className={tone === "critical" ? "text-red-600/80" : "text-slate-500"}>{label}</div>
      <div
        className={`text-xs font-medium tabular-nums ${tone === "critical" ? "text-red-700" : "text-slate-500"}`}
      >
        {value}
      </div>
    </div>
  );
}
