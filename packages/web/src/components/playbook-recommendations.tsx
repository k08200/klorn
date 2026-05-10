"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import type {
  EvePlaybookDomain,
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

  return (
    <section className="mb-6" aria-label="EVE playbook recommendations">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-stone-100">추천 플레이북</h2>
        <span className="text-[11px] text-stone-500">{data.recommendations.length}</span>
      </div>
      <div className="space-y-2">
        {data.recommendations.map((recommendation) => (
          <PlaybookCard key={recommendation.playbook.id} recommendation={recommendation} />
        ))}
      </div>
    </section>
  );
}

function PlaybookCard({ recommendation }: { recommendation: PlaybookRecommendation }) {
  const domain = domainMeta(recommendation.playbook.domain);
  const primaryContext = recommendation.activeContexts[0] ?? null;

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

function domainMeta(domain: EvePlaybookDomain): { label: string; className: string } {
  switch (domain) {
    case "investment":
      return {
        label: "투자",
        className: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
      };
    case "customer_success":
      return { label: "CS", className: "border-sky-400/20 bg-sky-400/10 text-sky-300" };
    case "launch":
      return {
        label: "런칭",
        className: "border-fuchsia-400/20 bg-fuchsia-400/10 text-fuchsia-300",
      };
    case "hiring":
      return { label: "채용", className: "border-amber-400/20 bg-amber-400/10 text-amber-300" };
  }
}
