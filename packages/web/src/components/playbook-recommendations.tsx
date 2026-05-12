"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import type {
  JigeumPlaybookDomain,
  PlaybookContextHit,
  PlaybookRecommendation,
  PlaybookRecommendationSummary,
} from "../lib/playbooks";

const EMPTY_SUMMARY: PlaybookRecommendationSummary = {
  generatedAt: "",
  playbooks: [],
  recommendations: [],
};

export default function PlaybookRecommendations() {
  const [data, setData] = useState<PlaybookRecommendationSummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const summary = await apiFetch<PlaybookRecommendationSummary>(
        "/api/playbooks/recommendations?limit=2&contextLimit=12",
      ).catch(() => EMPTY_SUMMARY);
      setData(summary);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener("conversations-updated", handler);
    return () => window.removeEventListener("conversations-updated", handler);
  }, [refresh]);

  if (loading && data.recommendations.length === 0) return null;
  if (data.recommendations.length === 0) return null;

  const setActivation = async (playbookId: string, active: boolean) => {
    if (updating) return;
    setUpdating(playbookId);
    try {
      await apiFetch(`/api/playbooks/${playbookId}/activate`, {
        method: active ? "POST" : "DELETE",
      });
      await refresh();
    } finally {
      setUpdating(null);
    }
  };

  return (
    <section className="mb-6" aria-label="Jigeum recommended playbooks">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-stone-100">Recommended playbooks</h2>
        <span className="text-[11px] text-stone-500">{data.recommendations.length}</span>
      </div>
      <div className="space-y-2">
        {data.recommendations.map((recommendation) => (
          <PlaybookCard
            key={recommendation.playbook.id}
            recommendation={recommendation}
            updating={updating === recommendation.playbook.id}
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
    <article className="rounded-xl border border-stone-800 bg-stone-900/40 p-4 transition hover:bg-stone-900/60">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${domain.className}`}
            >
              {domain.label}
            </span>
            <span className="text-[11px] text-stone-500">
              {Math.round(recommendation.confidence * 100)}%
            </span>
            {active && (
              <span className="rounded border border-emerald-400/20 bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                Active
              </span>
            )}
          </div>
          <p className="mt-2 truncate text-sm font-medium text-stone-100">
            {recommendation.playbook.name}
          </p>
          <p className="mt-1 line-clamp-1 text-xs text-stone-400">
            {recommendation.reasons[0] || recommendation.playbook.bestFor}
          </p>
        </div>
        <span className="shrink-0 rounded border border-stone-700 bg-stone-950/40 px-2 py-1 text-[11px] text-stone-400">
          {recommendation.score}
        </span>
      </div>

      {primaryContext && <ContextLink context={primaryContext} />}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {recommendation.suggestedFirstActions.slice(0, 2).map((step) => (
          <span
            key={step.id}
            className="rounded border border-stone-800 px-1.5 py-0.5 text-[11px] text-stone-400"
          >
            {step.title}
          </span>
        ))}
      </div>
      <button
        type="button"
        onClick={onToggle}
        disabled={updating}
        className={`mt-3 h-8 rounded-md border px-3 text-xs transition disabled:opacity-50 ${
          active
            ? "border-stone-700 text-stone-400 hover:bg-stone-800"
            : "border-amber-300/25 bg-amber-300/10 text-amber-200 hover:bg-amber-300/15"
        }`}
      >
        {updating ? "Saving..." : active ? "Pause" : "Activate"}
      </button>
    </article>
  );
}

function ContextLink({ context }: { context: PlaybookContextHit }) {
  const content = (
    <div className="mt-3 rounded-lg border border-stone-800/70 bg-stone-950/30 px-3 py-2">
      <div className="flex items-center gap-2">
        <RiskDot risk={context.risk} />
        <p className="min-w-0 truncate text-xs text-stone-300">{context.title}</p>
      </div>
      <p className="mt-1 line-clamp-1 text-[11px] text-stone-500">
        {context.matchedKeywords.slice(0, 3).join(" · ")}
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

function domainMeta(domain: JigeumPlaybookDomain): { label: string; className: string } {
  switch (domain) {
    case "investment":
      return {
        label: "Investment",
        className: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
      };
    case "customer_success":
      return { label: "CS", className: "border-sky-400/20 bg-sky-400/10 text-sky-300" };
    case "launch":
      return {
        label: "Launch",
        className: "border-fuchsia-400/20 bg-fuchsia-400/10 text-fuchsia-300",
      };
    case "hiring":
      return { label: "Hiring", className: "border-amber-400/20 bg-amber-400/10 text-amber-300" };
  }
}
