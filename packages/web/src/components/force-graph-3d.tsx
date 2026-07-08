"use client";

import { useEffect, useRef } from "react";
import { type GraphEdge, type GraphNode, TIER_COLORS } from "./relationship-graph";

// 4-tier colours come from the shared token map in relationship-graph so the
// 2D SVG, this 3D view, the firewall board, and legend never drift apart.

function colorFor(n: GraphNode): string {
  if (n.kind === "self") return "#fbbf24"; // == --color-accent
  if (n.kind === "feature") return "#a78bfa";
  if (n.kind === "tier") return TIER_COLORS[n.tags?.[0] ?? ""] ?? "#a78bfa";
  if (n.tags?.includes("overdue_reply")) return "#fb7185"; // reuses PUSH rose
  if (n.tags?.includes("meeting_soon")) return "#f59e0b";
  // Learned engagement (from the user's own replies) outranks raw frequency.
  if (n.tags?.includes("you_engage")) return "#f472b6";
  if (n.tags?.includes("frequent")) return "#34d399";
  return "#60a5fa";
}

/** Sphere volume — bigger for you/tiers and high-score contacts. */
function valFor(n: GraphNode): number {
  if (n.kind === "self") return 28;
  if (n.kind === "tier") return 18;
  if (n.kind === "feature") return 10;
  // Learned importance grows the node — the graph swells toward the people the
  // user actually engages with, not just whoever emails the most.
  return 2 + Math.max(0, n.score) / 12 + (n.learnedImportance ?? 0) * 8;
}

/**
 * 3D force-directed graph (three.js via 3d-force-graph). Client-only — the
 * library touches WebGL/window, so the page imports this with next/dynamic
 * { ssr: false }. We drive the vanilla (framework-agnostic) instance imperatively
 * to sidestep React-wrapper peer-dep churn.
 */
export function ForceGraph3DView({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;
    // biome-ignore lint/suspicious/noExplicitAny: 3d-force-graph has no first-class types here.
    let graph: any;

    (async () => {
      const ForceGraph3D = (await import("3d-force-graph")).default;
      if (disposed || !containerRef.current) return;
      const height = Math.round(window.innerHeight * 0.72);
      graph = new ForceGraph3D(containerRef.current)
        .backgroundColor("#0c0c10")
        .width(containerRef.current.clientWidth)
        .height(height)
        .graphData({
          nodes: nodes.map((n) => ({
            id: n.id,
            label: n.label,
            color: colorFor(n),
            val: valFor(n),
          })),
          links: edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind })),
        })
        .nodeLabel("label")
        .nodeColor("color")
        .nodeVal("val")
        .nodeOpacity(0.95)
        .nodeResolution(12)
        .linkColor(() => "#57534e")
        .linkOpacity(0.35)
        .linkWidth(0.4)
        .linkDirectionalParticles(2)
        .linkDirectionalParticleWidth(1.4)
        .linkDirectionalParticleSpeed(0.006);

      graph.cameraPosition({ z: 340 });
      // Slow auto-orbit for the "alive" feel; users can still drag/zoom.
      const controls = graph.controls?.();
      if (controls) {
        controls.autoRotate = true;
        controls.autoRotateSpeed = 0.55;
      }
    })();

    return () => {
      disposed = true;
      if (graph?._destructor) graph._destructor();
      if (el) el.innerHTML = "";
    };
  }, [nodes, edges]);

  return (
    <div
      ref={containerRef}
      className="overflow-hidden rounded-2xl border border-stone-700/45"
      style={{ minHeight: "60vh" }}
    />
  );
}
