"use client";

import { useMemo } from "react";

export interface GraphNode {
  id: string;
  label: string;
  kind: string; // "self" | "contact"
  score: number;
  group: string;
  tags: string[];
  lastEmailDaysAgo?: number | null;
  upcomingMeetings?: number;
  /**
   * Learned from the user's own outbound replies/sends (0..1). Not inbound
   * frequency — who they actually reach back to. Sizes/colours the node so the
   * graph shows what Klorn learned matters, straight from the user's actions.
   */
  learnedImportance?: number | null;
  outboundCount?: number;
  /**
   * Inferred importance for a quiet contact at an org the user engages with —
   * a soft cold-start prior, rendered lighter than direct engagement.
   */
  propagatedImportance?: number | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: string; // "interaction" | "org"
  weight: number;
}

const W = 1000;
const H = 680;
const ITERATIONS = 300;

// The 4 tiers, coloured from the single --color-tier-* token source of truth
// (globals.css @theme) so the graph reads as ONE system with the firewall
// board + tier badges. Kept as literals mirroring the tokens because SVG/
// WebGL fills can't consume Tailwind utility classes.
export const TIER_COLORS: Record<string, string> = {
  PUSH: "#fb7185", // --color-tier-push
  QUEUE: "#fbbf24", // --color-tier-queue
  SILENT: "#a8a29e", // --color-tier-silent
  AUTO: "#34d399", // --color-tier-auto
};

// Relationship-signal colours (not part of the 4-tier system).
const SELF_COLOR = "#0ea5e9"; // you (== --color-accent)
const FEATURE_COLOR = "#a78bfa"; // a scored input feature (violet)
const OVERDUE_COLOR = "#fb7185"; // waiting on a reply (reuses PUSH rose)
const MEETING_COLOR = "#f59e0b"; // meeting coming up
const FREQUENT_COLOR = "#34d399"; // high-frequency contact
const CONTACT_COLOR = "#60a5fa"; // a plain contact
const ENGAGED_COLOR = "#f472b6"; // you actually reach back to them (learned)
const ORG_ENGAGED_COLOR = "#c084fc"; // inferred via an org you engage with (softer)

/** Node colour. Relationships mode keys off tags; decisions mode off kind. */
function colorFor(n: GraphNode): string {
  if (n.kind === "self") return SELF_COLOR;
  if (n.kind === "feature") return FEATURE_COLOR;
  if (n.kind === "tier") return TIER_COLORS[n.tags[0] ?? ""] ?? FEATURE_COLOR;
  if (n.tags.includes("overdue_reply")) return OVERDUE_COLOR;
  if (n.tags.includes("meeting_soon")) return MEETING_COLOR;
  // Learned engagement outranks raw frequency — it's derived from the user's
  // own actions, not just how much someone emails them.
  if (n.tags.includes("you_engage")) return ENGAGED_COLOR;
  if (n.tags.includes("org_engaged")) return ORG_ENGAGED_COLOR;
  if (n.tags.includes("frequent")) return FREQUENT_COLOR;
  return CONTACT_COLOR;
}

function radiusFor(n: GraphNode): number {
  if (n.kind === "self") return 17;
  if (n.kind === "tier") return 15;
  if (n.kind === "feature") return 11;
  // Learned importance visibly enlarges the people the user engages with — the
  // graph grows toward what it learned, so "it's accurate" reads at a glance.
  // Propagated (inferred) importance nudges size too, but softer.
  const learned = (n.learnedImportance ?? 0) * 6 + (n.propagatedImportance ?? 0) * 3;
  return 5 + Math.sqrt(Math.max(0, n.score)) * 1.4 + learned;
}

interface Pt {
  x: number;
  y: number;
}

/**
 * Deterministic Fruchterman–Reingold force layout. Pure (no deps, no random):
 * nodes seed on a circle by index so the same graph always settles the same way.
 */
function computeLayout(nodes: GraphNode[], edges: GraphEdge[]): Map<string, Pt> {
  const pos = new Map<string, Pt>();
  const n = Math.max(1, nodes.length);
  nodes.forEach((node, i) => {
    const a = (2 * Math.PI * i) / n;
    pos.set(node.id, { x: W / 2 + Math.cos(a) * W * 0.3, y: H / 2 + Math.sin(a) * H * 0.3 });
  });
  const k = Math.sqrt((W * H) / n); // ideal edge length

  for (let it = 0; it < ITERATIONS; it++) {
    const disp = new Map<string, Pt>(nodes.map((node) => [node.id, { x: 0, y: 0 }]));

    // Repulsion between every pair (O(n^2) — fine for ≤ a few hundred nodes).
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = pos.get(nodes[i].id);
        const b = pos.get(nodes[j].id);
        if (!a || !b) continue;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const f = (k * k) / d;
        dx /= d;
        dy /= d;
        const di = disp.get(nodes[i].id);
        const dj = disp.get(nodes[j].id);
        if (di) {
          di.x += dx * f;
          di.y += dy * f;
        }
        if (dj) {
          dj.x -= dx * f;
          dj.y -= dy * f;
        }
      }
    }

    // Attraction along edges.
    for (const e of edges) {
      const a = pos.get(e.source);
      const b = pos.get(e.target);
      if (!a || !b) continue;
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const f = (d * d) / k;
      dx /= d;
      dy /= d;
      const da = disp.get(e.source);
      const db = disp.get(e.target);
      if (da) {
        da.x -= dx * f;
        da.y -= dy * f;
      }
      if (db) {
        db.x += dx * f;
        db.y += dy * f;
      }
    }

    // Cool down + gentle centering so the layout doesn't drift off-canvas.
    const temp = Math.max(1, W * 0.1 * (1 - it / ITERATIONS));
    for (const node of nodes) {
      const dp = disp.get(node.id);
      const p = pos.get(node.id);
      if (!dp || !p) continue;
      const dl = Math.hypot(dp.x, dp.y) || 0.01;
      p.x += (dp.x / dl) * Math.min(dl, temp);
      p.y += (dp.y / dl) * Math.min(dl, temp);
      p.x += (W / 2 - p.x) * 0.005;
      p.y += (H / 2 - p.y) * 0.005;
    }
  }
  return pos;
}

export function RelationshipGraph({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const { pos, viewBox } = useMemo(() => {
    const p = computeLayout(nodes, edges);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const pt of p.values()) {
      minX = Math.min(minX, pt.x);
      minY = Math.min(minY, pt.y);
      maxX = Math.max(maxX, pt.x);
      maxY = Math.max(maxY, pt.y);
    }
    const pad = 60;
    if (!Number.isFinite(minX)) {
      return { pos: p, viewBox: `0 0 ${W} ${H}` };
    }
    return {
      pos: p,
      viewBox: `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`,
    };
  }, [nodes, edges]);

  if (nodes.length <= 1) {
    return (
      <p className="rounded-xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
        No relationships yet — the graph fills in as mail and calendar activity accrues.
      </p>
    );
  }

  return (
    <svg
      viewBox={viewBox}
      className="h-[70vh] w-full rounded-2xl border border-slate-200 bg-slate-50"
      role="img"
      aria-label="Relationship graph of your contacts"
    >
      <title>Relationship graph</title>
      {edges.map((e) => {
        const a = pos.get(e.source);
        const b = pos.get(e.target);
        if (!a || !b) return null;
        return (
          <line
            key={`${e.source}->${e.target}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={e.kind === "org" ? "#78716c" : "#44403c"}
            strokeWidth={e.kind === "org" ? 1.2 : 0.8}
            strokeOpacity={0.5}
          />
        );
      })}
      {nodes.map((n) => {
        const p = pos.get(n.id);
        if (!p) return null;
        const r = radiusFor(n);
        return (
          <g key={n.id}>
            <circle cx={p.x} cy={p.y} r={r} fill={colorFor(n)} fillOpacity={0.9} />
            <text
              x={p.x}
              y={p.y - r - 3}
              textAnchor="middle"
              className="fill-slate-600"
              style={{ fontSize: n.kind === "self" || n.kind === "tier" ? 12 : 10 }}
            >
              {n.label.length > 42 ? `${n.label.slice(0, 41)}…` : n.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
