"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import type { GraphEdge, GraphNode } from "../../components/relationship-graph";
import { useToast } from "../../components/toast";
import { apiFetch } from "../../lib/api";
import { captureClientError } from "../../lib/sentry";

// 3d-force-graph touches WebGL/window — load it client-only.
const ForceGraph3DView = dynamic(
  () => import("../../components/force-graph-3d").then((m) => m.ForceGraph3DView),
  {
    ssr: false,
    loading: () => <p className="text-sm text-stone-500">Loading 3D graph…</p>,
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
// the 4 tiers are still distinguishable without relying on hue alone.
type SwatchShape = "circle" | "diamond" | "square" | "ring" | "triangle";

const REL_LEGEND: Array<{ color: string; label: string; shape: SwatchShape }> = [
  { color: "#fbbf24", label: "You", shape: "diamond" },
  { color: "#fb7185", label: "Waiting on a reply", shape: "triangle" },
  { color: "#f59e0b", label: "Meeting soon", shape: "square" },
  { color: "#f472b6", label: "You engage (learned)", shape: "diamond" },
  { color: "#34d399", label: "Frequent contact", shape: "ring" },
  { color: "#60a5fa", label: "Contact", shape: "circle" },
];

// Tier colours mirror --color-tier-* (globals.css) so the decision-brain view
// reads identically to the firewall board.
const DEC_LEGEND: Array<{ color: string; label: string; shape: SwatchShape }> = [
  { color: "#a78bfa", label: "Feature (scored input)", shape: "square" },
  { color: "#fb7185", label: "PUSH", shape: "diamond" },
  { color: "#fbbf24", label: "QUEUE", shape: "square" },
  { color: "#a8a29e", label: "SILENT", shape: "ring" },
  { color: "#34d399", label: "AUTO", shape: "circle" },
];

const SWATCH_CLASS: Record<SwatchShape, string> = {
  circle: "rounded-full",
  diamond: "rotate-45 rounded-[2px]",
  square: "rounded-[2px]",
  ring: "rounded-full border-2 bg-transparent",
  triangle: "[clip-path:polygon(50%_0%,100%_100%,0%_100%)]",
};

const COPY: Record<Mode, { eyebrow: string; title: string; body: string }> = {
  relationships: {
    eyebrow: "Relationships",
    title: "Who matters to your inbox",
    body: "A force-directed view of the relationship graph the firewall already reasons over — your ranked contacts (size = interaction score, colour = current signal) clustered by company domain. The people you actually reply to grow larger and turn pink: Klorn learns who matters from your own actions and feeds that back into how it triages.",
  },
  decisions: {
    eyebrow: "Decision brain",
    title: "How the firewall decides",
    body: "The classifier's deterministic core: the 4 scored features gating the 4 tiers (the tierFromFeatures rule), with your override signal overlaid on each tier. This is the policy structure itself, so it renders even before you've corrected anything.",
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
      toast("Could not load the graph.", "error");
    } finally {
      setLoading(false);
    }
  }, [toast, mode]);

  useEffect(() => {
    load();
  }, [load]);

  const copy = COPY[mode];
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
    <div className="h-full overflow-y-auto bg-surface-app px-4 pb-28 pt-6 text-stone-50 sm:px-6 md:py-10">
      <div className="mx-auto max-w-5xl">
        <div
          role="group"
          aria-label="Graph view"
          className="mb-4 inline-flex rounded-xl border border-stone-700/45 bg-stone-950/40 p-1"
        >
          {(["relationships", "decisions"] as Mode[]).map((mKey) => (
            <button
              key={mKey}
              type="button"
              aria-pressed={mode === mKey}
              onClick={() => setMode(mKey)}
              className={`rounded-lg px-3 py-1.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                mode === mKey
                  ? "bg-accent font-semibold text-stone-950"
                  : "text-stone-400 hover:text-stone-200"
              }`}
            >
              {mKey === "relationships" ? "Relationships" : "Decision brain"}
            </button>
          ))}
        </div>

        <header className="mb-6 rounded-2xl border border-stone-700/45 bg-stone-950/35 p-5 shadow-sm shadow-black/20">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-300">
            {copy.eyebrow}
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-50">{copy.title}</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-400">{copy.body}</p>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-stone-500">
            {mode === "relationships" ? (
              <>
                <span>{contactCount} contacts</span>
                {data?.builtAt && (
                  <span>· built {new Date(data.builtAt).toLocaleString("en-US")}</span>
                )}
              </>
            ) : (
              <>
                <span>
                  override rate{" "}
                  {data?.overrideRate != null ? `${(data.overrideRate * 100).toFixed(0)}%` : "—"}
                </span>
                {data?.overriddenKnobs && data.overriddenKnobs.length > 0 && (
                  <span>· live overrides: {data.overriddenKnobs.join(", ")}</span>
                )}
              </>
            )}
          </div>
        </header>

        <div className="mb-4 flex flex-wrap gap-x-4 gap-y-2">
          {legend.map((l) => (
            <span key={l.label} className="flex items-center gap-1.5 text-xs text-stone-400">
              <span
                aria-hidden="true"
                className={`inline-block h-2.5 w-2.5 shrink-0 ${SWATCH_CLASS[l.shape]}`}
                style={l.shape === "ring" ? { borderColor: l.color } : { backgroundColor: l.color }}
              />
              {l.label}
            </span>
          ))}
        </div>

        {loading ? (
          <p className="text-sm text-stone-500">Loading...</p>
        ) : !data ? (
          <p className="rounded-xl border border-stone-700/45 bg-stone-950/35 p-6 text-sm text-stone-400">
            No graph data.
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
  if (nodes.length === 0) return null;
  const scoreLabel = mode === "decisions" ? "weight" : "interaction score";
  return (
    <section className="mt-6 rounded-2xl border border-stone-700/45 bg-stone-950/35 p-5">
      <h2 className="text-sm font-semibold text-stone-200">
        {mode === "decisions" ? "Top decision signals" : "Top contacts"}
      </h2>
      <p className="mt-1 text-xs text-stone-500">
        A text view of the graph for keyboard and screen-reader users — the same ranked nodes shown
        visually above ({scoreLabel}, highest first).
      </p>
      <ol className="mt-3 space-y-1.5">
        {nodes.map((n) => (
          <li
            key={n.id}
            className="flex items-baseline justify-between gap-3 border-b border-stone-800/50 pb-1.5 text-sm text-stone-300 last:border-0"
          >
            <span className="min-w-0 truncate">{n.label}</span>
            <span className="shrink-0 tabular-nums text-xs text-stone-500">
              {Math.round(n.score)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
