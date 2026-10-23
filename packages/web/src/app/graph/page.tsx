"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { TIER_COUNT } from "@/lib/tiers";
import AuthGuard from "../../components/auth-guard";
import type { GraphEdge, GraphNode } from "../../components/relationship-graph";
import { useToast } from "../../components/toast";
import LoadingState from "../../components/ui/loading-state";
import { apiFetch } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { captureClientError } from "../../lib/sentry";

// 3d-force-graph touches WebGL/window — load it client-only.
const ForceGraph3DView = dynamic(
  () => import("../../components/force-graph-3d").then((m) => m.ForceGraph3DView),
  {
    ssr: false,
    loading: () => <LoadingState rows={1} rowHeight="h-96" />,
  },
);

type Mode = "relationships" | "decisions";

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  builtAt?: string;
  overrideRate?: number | null;
  overriddenKnobs?: string[];
}

// Legend swatch shapes double as a non-colour differentiator (WCAG 1.4.1) so
// the lanes are still distinguishable without relying on hue alone.
type SwatchShape = "circle" | "diamond" | "square" | "ring" | "triangle";

// Labels are i18n keys; lane rows reuse the canonical lane names.
const REL_LEGEND: Array<{ color: string; label: string; shape: SwatchShape }> = [
  { color: "#fbbf24", label: "graph.legend.you", shape: "diamond" },
  { color: "#fb7185", label: "graph.legend.waiting", shape: "triangle" },
  { color: "#f59e0b", label: "graph.legend.meetingSoon", shape: "square" },
  { color: "#f472b6", label: "graph.legend.engaged", shape: "diamond" },
  { color: "#c084fc", label: "graph.legend.orgEngaged", shape: "diamond" },
  { color: "#34d399", label: "graph.legend.frequent", shape: "ring" },
  { color: "#60a5fa", label: "graph.legend.contact", shape: "circle" },
];

// Tier colours mirror --color-tier-* (globals.css) so the decision-brain view
// reads identically to the firewall board.
const DEC_LEGEND: Array<{ color: string; label: string; shape: SwatchShape }> = [
  { color: "#a78bfa", label: "graph.legend.feature", shape: "square" },
  { color: "#fb7185", label: "lane.name.PUSH", shape: "diamond" },
  { color: "#818cf8", label: "lane.name.MEETING", shape: "circle" },
  { color: "#fbbf24", label: "lane.name.QUEUE", shape: "square" },
  { color: "#22d3ee", label: "lane.name.INFO", shape: "ring" },
  { color: "#a8a29e", label: "lane.name.SILENT", shape: "ring" },
];

const SWATCH_CLASS: Record<SwatchShape, string> = {
  circle: "rounded-full",
  diamond: "rotate-45 rounded-[2px]",
  square: "rounded-[2px]",
  ring: "rounded-full border-2 bg-transparent",
  triangle: "[clip-path:polygon(50%_0%,100%_100%,0%_100%)]",
};

const COPY_KEYS: Record<Mode, { eyebrow: string; title: string; body: string }> = {
  relationships: {
    eyebrow: "graph.mode.relationships",
    title: "graph.relationships.title",
    body: "graph.relationships.body",
  },
  decisions: {
    eyebrow: "graph.mode.decisions",
    title: "graph.decisions.title",
    body: "graph.decisions.body",
  },
};

export default function GraphPage() {
  return (
    <AuthGuard>
      <GraphPageInner />
    </AuthGuard>
  );
}

function GraphPageInner() {
  const { toast } = useToast();
  const { t, locale } = useT();
  const [mode, setMode] = useState<Mode>("relationships");
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiFetch<GraphData>(`/api/inbox/firewall/graph?mode=${mode}`));
    } catch (err) {
      // Don't surface the raw apiFetch error to the user — log the detail, show
      // a fixed message.
      captureClientError(err, { scope: "graph.load" });
      toast(t("statePage.graphLoadError"), "error");
    } finally {
      setLoading(false);
    }
  }, [toast, mode, t]);

  useEffect(() => {
    load();
  }, [load]);

  const copy = COPY_KEYS[mode];
  const legend = mode === "decisions" ? DEC_LEGEND : REL_LEGEND;
  const contactCount = data ? data.nodes.filter((n) => n.kind === "contact").length : 0;
  // Top nodes by score — a keyboard/AT-reachable text fallback for the WebGL
  // force-graph, which is otherwise pointer-only and has no text alternative.
  const topNodes = data
    ? [...data.nodes]
        .filter((n) => n.kind !== "self")
        .sort((a, b) => b.score - a.score)
        .slice(0, 12)
    : [];

  return (
    <div className="h-full overflow-y-auto bg-surface-app px-4 pb-28 pt-6 text-ink sm:px-6 md:py-10">
      <div className="mx-auto max-w-5xl">
        <div
          role="group"
          aria-label={t("graph.view.aria")}
          className="mb-4 inline-flex rounded-xl border border-line bg-surface-raised p-1"
        >
          {(["relationships", "decisions"] as Mode[]).map((mKey) => (
            <button
              key={mKey}
              type="button"
              aria-pressed={mode === mKey}
              onClick={() => setMode(mKey)}
              className={`rounded-lg px-3 py-1.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                mode === mKey
                  ? "bg-accent-solid font-semibold text-accent-solid-ink"
                  : "text-ink-mid hover:text-ink"
              }`}
            >
              {t(`graph.mode.${mKey}`)}
            </button>
          ))}
        </div>

        <header className="mb-6 rounded-2xl border border-line bg-surface-panel p-5 shadow-sm shadow-black/20">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-deep">
            {t(copy.eyebrow)}
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink">{t(copy.title)}</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-ink-mid">
            {t(copy.body, { count: String(TIER_COUNT) })}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-dim">
            {mode === "relationships" ? (
              <>
                <span>{t("graph.stats.contacts", { count: String(contactCount) })}</span>
                {data?.builtAt && (
                  <span>
                    ·{" "}
                    {t("graph.stats.built", {
                      time: new Date(data.builtAt).toLocaleString(locale),
                    })}
                  </span>
                )}
              </>
            ) : (
              <>
                <span>
                  {t("graph.stats.overrideRate", {
                    rate:
                      data?.overrideRate != null ? `${(data.overrideRate * 100).toFixed(0)}%` : "—",
                  })}
                </span>
                {data?.overriddenKnobs && data.overriddenKnobs.length > 0 && (
                  <span>
                    · {t("graph.stats.liveOverrides", { list: data.overriddenKnobs.join(", ") })}
                  </span>
                )}
              </>
            )}
          </div>
        </header>

        <div className="mb-4 flex flex-wrap gap-x-4 gap-y-2">
          {legend.map((l) => (
            <span key={l.label} className="flex items-center gap-1.5 text-xs text-ink-mid">
              <span
                aria-hidden="true"
                className={`inline-block h-2.5 w-2.5 shrink-0 ${SWATCH_CLASS[l.shape]}`}
                style={l.shape === "ring" ? { borderColor: l.color } : { backgroundColor: l.color }}
              />
              {t(l.label)}
            </span>
          ))}
        </div>

        {loading ? (
          <LoadingState rows={1} rowHeight="h-96" label={t("statePage.graphLoading")} />
        ) : !data ? (
          <p className="rounded-xl border border-line bg-surface-raised p-6 text-sm text-ink-mid">
            {t("graph.noData")}
          </p>
        ) : (
          <>
            <ForceGraph3DView nodes={data.nodes} edges={data.edges} />
            <TopNodesFallback nodes={topNodes} mode={mode} />
          </>
        )}
      </div>
    </div>
  );
}

// Keyboard + screen-reader alternative to the pointer-only WebGL graph
// (WCAG 1.1.1 / 2.1.1): the highest-scoring nodes as a plain readable list.
function TopNodesFallback({ nodes, mode }: { nodes: GraphNode[]; mode: Mode }) {
  const { t } = useT();
  if (nodes.length === 0) return null;
  return (
    <section className="mt-6 rounded-2xl border border-line bg-surface-panel p-5">
      <h2 className="text-sm font-semibold text-ink">
        {t(mode === "decisions" ? "graph.top.decisions" : "graph.top.contacts")}
      </h2>
      <p className="mt-1 text-xs text-ink-dim">
        {t(mode === "decisions" ? "graph.top.bodyDecisions" : "graph.top.bodyContacts")}
      </p>
      <ol className="mt-3 space-y-1.5">
        {nodes.map((n) => (
          <li
            key={n.id}
            className="flex items-baseline justify-between gap-3 border-b border-line-soft pb-1.5 text-sm text-ink-mid last:border-0"
          >
            <span className="min-w-0 truncate">{n.label}</span>
            <span className="shrink-0 tabular-nums text-xs text-ink-dim">
              {Math.round(n.score)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
