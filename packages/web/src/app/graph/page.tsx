"use client";

import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import {
  type GraphEdge,
  type GraphNode,
  RelationshipGraph,
} from "../../components/relationship-graph";
import { useToast } from "../../components/toast";
import { apiFetch } from "../../lib/api";

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  builtAt: string;
}

const LEGEND: Array<{ color: string; label: string }> = [
  { color: "#fbbf24", label: "You" },
  { color: "#f87171", label: "Waiting on a reply" },
  { color: "#f59e0b", label: "Meeting soon" },
  { color: "#34d399", label: "Frequent contact" },
  { color: "#60a5fa", label: "Contact" },
];

export default function GraphPage() {
  return (
    <AuthGuard>
      <GraphPageInner />
    </AuthGuard>
  );
}

function GraphPageInner() {
  const { toast } = useToast();
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiFetch<GraphData>("/api/inbox/firewall/graph"));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not load the graph.", "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const contactCount = data ? data.nodes.filter((n) => n.kind === "contact").length : 0;

  return (
    <main className="min-h-dvh bg-[#10100d] px-4 pb-28 pt-6 text-stone-50 sm:px-6 md:py-10">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 rounded-2xl border border-stone-700/45 bg-stone-950/35 p-5 shadow-sm shadow-black/20">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-300">
            Relationships
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-50">
            Who matters to your inbox
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-400">
            A force-directed view of the relationship graph the firewall already reasons over — your
            ranked contacts (size = interaction score, colour = current signal) clustered by company
            domain. Read-only over your existing mail + calendar data; no new graph store.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-stone-500">
            <span>{contactCount} contacts</span>
            {data?.builtAt && <span>· built {new Date(data.builtAt).toLocaleString()}</span>}
          </div>
        </header>

        <div className="mb-4 flex flex-wrap gap-x-4 gap-y-2">
          {LEGEND.map((l) => (
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
          <RelationshipGraph nodes={data.nodes} edges={data.edges} />
        )}
      </div>
    </main>
  );
}
