"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect } from "react";
import { apiFetch } from "../lib/api";
import type {
  KlornPlaybookDomain,
  PlaybookContextHit,
  PlaybookRecommendation,
  PlaybookRecommendationSummary,
} from "../lib/playbooks";
import { queryKeys } from "../lib/query-keys";

const RECOMMENDATIONS_PARAMS = { limit: 2, contextLimit: 12 } as const;

const EMPTY_SUMMARY: PlaybookRecommendationSummary = {
  generatedAt: "",
  playbooks: [],
  recommendations: [],
};

export default function PlaybookRecommendations() {
  const queryClient = useQueryClient();

  const { data = EMPTY_SUMMARY, isPending: loading } = useQuery({
    queryKey: queryKeys.playbooks.recommendations(RECOMMENDATIONS_PARAMS),
    queryFn: async () => {
      try {
        return await apiFetch<PlaybookRecommendationSummary>(
          `/api/playbooks/recommendations?limit=${RECOMMENDATIONS_PARAMS.limit}&contextLimit=${RECOMMENDATIONS_PARAMS.contextLimit}`,
        );
      } catch {
        // Match prior behavior: swallow errors and surface as empty state
        // so the recommendations strip stays hidden on transient failures.
        return EMPTY_SUMMARY;
      }
    },
  });

  // Refetch when chat conversations land — same trigger the old version used
  // to keep recommendations responsive to recent context.
  useEffect(() => {
    const handler = () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.playbooks.recommendations(RECOMMENDATIONS_PARAMS),
      });
    };
    window.addEventListener("conversations-updated", handler);
    return () => window.removeEventListener("conversations-updated", handler);
  }, [queryClient]);

  const toggleMutation = useMutation({
    mutationFn: ({ playbookId, active }: { playbookId: string; active: boolean }) =>
      apiFetch(`/api/playbooks/${playbookId}/activate`, {
        method: active ? "POST" : "DELETE",
      }),
    onSettled: () => {
      // Sister page (`/settings/playbooks`) reads the same data — invalidate both.
      queryClient.invalidateQueries({ queryKey: queryKeys.playbooks.all });
    },
  });

  if (loading && data.recommendations.length === 0) return null;
  if (data.recommendations.length === 0) return null;

  const setActivation = (playbookId: string, active: boolean) => {
    if (toggleMutation.isPending) return;
    toggleMutation.mutate({ playbookId, active });
  };

  const updatingId = toggleMutation.isPending ? toggleMutation.variables?.playbookId : null;

  return (
    <section className="mb-6" aria-label="Klorn recommended playbooks">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Recommended Playbooks</h2>
        <span className="text-[11px] text-slate-400">{data.recommendations.length}</span>
      </div>
      <div className="space-y-2">
        {data.recommendations.map((recommendation) => (
          <PlaybookCard
            key={recommendation.playbook.id}
            recommendation={recommendation}
            updating={updatingId === recommendation.playbook.id}
            onToggle={() =>
              setActivation(recommendation.playbook.id, !recommendation.playbook.active)
            }
          />
        ))}
      </div>
    </section>
  );
}

function PlaybookCard({
  recommendation,
  updating,
  onToggle,
}: {
  recommendation: PlaybookRecommendation;
  updating: boolean;
  onToggle: () => void;
}) {
  const domain = domainMeta(recommendation.playbook.domain);
  const primaryContext = recommendation.activeContexts[0] ?? null;
  const active = Boolean(recommendation.playbook.active);

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 transition hover:bg-slate-50">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${domain.className}`}
            >
              {domain.label}
            </span>
            <span className="text-[11px] text-slate-400">
              {Math.round(recommendation.confidence * 100)}%
            </span>
            {active && (
              <span className="rounded border border-emerald-400/20 bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                Active
              </span>
            )}
          </div>
          <p className="mt-2 truncate text-sm font-medium text-slate-900">
            {displayText(recommendation.playbook.name)}
          </p>
          <p className="mt-1 line-clamp-1 text-xs text-slate-500">
            {displayText(recommendation.reasons[0] || recommendation.playbook.bestFor)}
          </p>
        </div>
        <span className="shrink-0 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-500">
          {recommendation.score}
        </span>
      </div>

      {primaryContext && <ContextLink context={primaryContext} />}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {recommendation.suggestedFirstActions.slice(0, 2).map((step) => (
          <span
            key={step.id}
            className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-500"
          >
            {displayText(step.title)}
          </span>
        ))}
      </div>
      <button
        type="button"
        onClick={onToggle}
        disabled={updating}
        className={`mt-3 h-8 rounded-md border px-3 text-xs transition disabled:opacity-50 ${
          active
            ? "border-slate-200 text-slate-500 hover:bg-slate-100"
            : "border-sky-300/25 bg-sky-300/10 text-sky-600 hover:bg-sky-300/15"
        }`}
      >
        {updating ? "Saving..." : active ? "Pause" : "Apply"}
      </button>
    </article>
  );
}

function ContextLink({ context }: { context: PlaybookContextHit }) {
  const content = (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <div className="flex items-center gap-2">
        <RiskDot risk={context.risk} />
        <p className="min-w-0 truncate text-xs text-slate-500">{context.title}</p>
      </div>
      <p className="mt-1 line-clamp-1 text-[11px] text-slate-400">
        {context.matchedKeywords.slice(0, 3).map(displayText).join(" · ")}
      </p>
    </div>
  );

  return context.href ? (
    <Link href={context.href} className="block">
      {content}
    </Link>
  ) : (
    content
  );
}

function RiskDot({ risk }: { risk: PlaybookContextHit["risk"] }) {
  const className =
    risk === "high" ? "bg-red-400" : risk === "medium" ? "bg-amber-300" : "bg-stone-500";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${className}`} />;
}

function domainMeta(domain: KlornPlaybookDomain): { label: string; className: string } {
  switch (domain) {
    case "investment":
      return {
        label: "Investors",
        className: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
      };
    case "customer_success":
      return { label: "Customers", className: "border-sky-400/20 bg-sky-400/10 text-sky-600" };
    case "launch":
      return {
        label: "Launch",
        className: "border-fuchsia-400/20 bg-fuchsia-400/10 text-fuchsia-300",
      };
    case "hiring":
      return { label: "Hiring", className: "border-amber-400/20 bg-amber-400/10 text-amber-300" };
  }
}

function displayText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/Investor Ops/g, "Investor Ops")
    .replace(/Investment/g, "Investment")
    .replace(/Medium-risk matching context/g, "Medium-risk context match")
    .replace(/Review investor-facing risks/g, "Review investor-facing risks")
    .replace(/Prepare update pack/g, "Prepare update pack")
    .replace(/venture/g, "venture");
}
