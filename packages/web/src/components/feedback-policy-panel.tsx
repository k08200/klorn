"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useT } from "../lib/i18n";
import { captureClientError } from "../lib/sentry";
import Button from "./ui/button";
import ErrorAlert from "./ui/error-alert";

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
  { labelKey: string; tone: string; dot: string; summaryKey: string }
> = {
  ALLOW_AFTER_SUGGESTION: {
    labelKey: "feedbackPolicy.kind.allow.label",
    tone: "bg-accent/10 text-accent-deep ring-accent/20",
    dot: "bg-accent",
    summaryKey: "feedbackPolicy.kind.allow.summary",
  },
  REQUIRE_DRAFT_REVIEW: {
    labelKey: "feedbackPolicy.kind.review.label",
    tone: "bg-surface-hover text-ink-mid ring-line",
    dot: "bg-slate-400",
    summaryKey: "feedbackPolicy.kind.review.summary",
  },
  AVOID_SUGGESTION: {
    labelKey: "feedbackPolicy.kind.avoid.label",
    tone: "bg-rose-500/10 text-rose-600 ring-rose-500/20",
    dot: "bg-rose-500",
    summaryKey: "feedbackPolicy.kind.avoid.summary",
  },
  LOWER_PRIORITY: {
    labelKey: "feedbackPolicy.kind.lower.label",
    tone: "bg-surface-hover text-ink-mid ring-line",
    dot: "bg-slate-400",
    summaryKey: "feedbackPolicy.kind.lower.summary",
  },
};

export function FeedbackPolicyPanel() {
  const { t } = useT();
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
    <div className="panel-elevated rounded-2xl border border-line/70 bg-surface-panel p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">{t("feedbackPolicy.title")}</h3>
          <p className="mt-0.5 text-xs text-ink-dim">
            {since
              ? t("feedbackPolicy.since", { date: new Date(since).toLocaleDateString("en-US") })
              : t("feedbackPolicy.recent")}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          loading={loading}
        >
          {t("pwa.update.refresh")}
        </Button>
      </div>

      {loading ? (
        <div className="mt-4 space-y-2">
          <div className="h-16 animate-pulse rounded-lg bg-surface-hover" />
          <div className="h-16 animate-pulse rounded-lg bg-surface-hover" />
        </div>
      ) : error ? (
        <ErrorAlert className="mt-4">{t("feedbackPolicy.error")}</ErrorAlert>
      ) : candidates.length === 0 ? (
        <div className="mt-4 rounded-lg border border-line bg-surface-raised px-3 py-3 text-sm text-ink-dim">
          {t("feedbackPolicy.empty")}
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {candidates.slice(0, 6).map((candidate) => {
            const copy = KIND_COPY[candidate.kind];
            return (
              <div
                key={candidate.id}
                className="rounded-lg border border-line bg-surface-raised px-3 py-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${copy.dot}`} />
                      <span className="break-words font-mono text-xs text-ink">
                        {candidate.scope.toolName}
                      </span>
                      {candidate.scope.recipient && (
                        <span className="break-all text-xs text-ink-dim">
                          {candidate.scope.recipient}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-ink-dim">{t(copy.summaryKey)}</p>
                  </div>
                  <span
                    className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ring-1 ring-inset ${copy.tone}`}
                  >
                    {t(copy.labelKey)}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-[10px] text-ink-dim sm:grid-cols-6">
                  <SignalCount
                    label={t("feedbackPolicy.count.approved")}
                    value={candidate.support.approved}
                  />
                  <SignalCount
                    label={t("feedbackPolicy.count.rejected")}
                    value={candidate.support.rejected}
                  />
                  <SignalCount
                    label={t("feedbackPolicy.count.edited")}
                    value={candidate.support.edited}
                  />
                  <SignalCount
                    label={t("feedbackPolicy.count.failed")}
                    value={candidate.support.failed}
                    tone="critical"
                  />
                  <SignalCount
                    label={t("feedbackPolicy.count.ignored")}
                    value={candidate.support.ignored}
                  />
                  <SignalCount
                    label={t("feedbackPolicy.count.snoozed")}
                    value={candidate.support.snoozed}
                  />
                  <SignalCount
                    label={t("feedbackPolicy.count.closed")}
                    value={candidate.support.dismissed}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between text-[10px] tabular-nums text-ink-mid">
                  <span>
                    {t("feedbackPolicy.confidence", {
                      percent: String(Math.round(candidate.confidence * 100)),
                    })}
                  </span>
                  <span>
                    {t("feedbackPolicy.events", { count: String(candidate.support.total) })}
                  </span>
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
    <div className="rounded-md bg-surface-hover px-2 py-1">
      <div className={tone === "critical" ? "text-state-danger-ink" : "text-ink-mid"}>{label}</div>
      <div
        className={`text-xs font-medium tabular-nums ${tone === "critical" ? "text-state-danger-ink" : "text-ink-mid"}`}
      >
        {value}
      </div>
    </div>
  );
}
