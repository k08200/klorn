"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import type { GraphEdge, GraphNode } from "../../components/relationship-graph";
import { useToast } from "../../components/toast";
import { apiFetch } from "../../lib/api";

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

const REL_LEGEND: Array<{ color: string; label: string }> = [
  { color: "#fbbf24", label: "You" },
  { color: "#f87171", label: "Waiting on a reply" },
  { color: "#f59e0b", label: "Meeting soon" },
  { color: "#34d399", label: "Frequent contact" },
  { color: "#60a5fa", label: "Contact" },
];

const DEC_LEGEND: Array<{ color: string; label: string }> = [
  { color: "#a78bfa", label: "Feature (scored input)" },
  { color: "#f87171", label: "PUSH" },
  { color: "#60a5fa", label: "QUEUE" },
  { color: "#9ca3af", label: "SILENT" },
  { color: "#34d399", label: "AUTO" },
];

const COPY: Record<Mode, { eyebrow: string; title: string; body: string }> = {
  relationships: {
    eyebrow: "Relationships",
    title: "Who matters to your inbox",
    body: "A force-directed view of the relationship graph the firewall already reasons over — your ranked contacts (size = interaction score, colour = current signal) clustered by company domain. Read-only over your existing mail + calendar data; no new graph store.",
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
      toast(err instanceof Error ? err.message : "Could not load the graph.", "error");
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

  return (
    <main className="h-full overflow-y-auto bg-[#10100d] px-4 pb-28 pt-6 text-stone-50 sm:px-6 md:py-10">
      <div className="mx-auto max-w-5xl">
        <div className="mb-4 inline-flex rounded-xl border border-stone-700/45 bg-stone-950/40 p-1">
          {(["relationships", "decisions"] as Mode[]).map((mKey) => (
            <button
              key={mKey}
              type="button"
              onClick={() => setMode(mKey)}
              className={`rounded-lg px-3 py-1.5 text-sm transition ${
                mode === mKey
                  ? "bg-amber-300 font-semibold text-stone-950"
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
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: l.color }}
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
          <ForceGraph3DView nodes={data.nodes} edges={data.edges} />
        )}
      </div>
    </main>
  );
}
