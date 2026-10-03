"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../lib/api";
import { captureClientError } from "../lib/sentry";
import { useToast } from "./toast";
import { TrustDot, type TrustScoreData } from "./trust-badge";

// Wire shapes come from @klorn/contract — the same types the server builds
// (routes/firewall.ts), so a response-shape change fails to compile here
// instead of silently desyncing. The old hand-mirrored copy had already
// drifted: it was missing `hashStale`.
export type { FirewallItem, FirewallResponse, Tier } from "@klorn/contract";

import type { DailyReceipt, FirewallItem, FirewallResponse, Tier } from "@klorn/contract";
import { CORE_TIERS } from "@/lib/tiers";

// lane-subset: INFO is a records lane and renders as a strip below the board
// (InfoStrip), not as a fourth column, so it is deliberately not a ColumnTier.
type ColumnTier = "PUSH" | "MEETING" | "QUEUE" | "SILENT";

// How often the firewall view re-pulls while the tab is focused.
export const FIREWALL_REFRESH_MS = 45_000;

// Spatial-triage visual language. Depth is meant to be felt before it is
// read: PUSH sits on a glowing, elevated plane; QUEUE is mid; SILENT
// recedes and desaturates. The class strings below encode that ladder.
export const TIER_VISUAL: Record<
  Tier,
  {
    label: string;
    description: string;
    plane: string; // column panel: glow + tint + border
    card: string; // per-card border + hover accent
    accent: string; // count + glyph color
    dot: string; // glyph fill
  }
> = {
  PUSH: {
    label: "PUSH",
    description: "Worth interrupting you for. Push notifications fire here.",
    plane:
      "tier-plane-push border-tier-push/35 bg-gradient-to-b from-tier-push/[0.07] to-transparent",
    card: "border-tier-push/15 bg-surface-panel hover:border-tier-push/45",
    accent: "text-tier-push-ink",
    dot: "text-tier-push-ink",
  },
  QUEUE: {
    label: "QUEUE",
    description: "Visible when you choose to look. No push.",
    plane:
      "tier-plane-queue border-tier-queue/25 bg-gradient-to-b from-tier-queue/[0.05] to-transparent",
    card: "border-tier-queue/10 bg-surface-panel hover:border-tier-queue/35",
    accent: "text-tier-queue-ink",
    dot: "text-tier-queue-ink",
  },
  SILENT: {
    label: "SILENT",
    description: "Recorded only. Klorn decided this wasn't worth surfacing.",
    plane: "tier-plane-silent border-line bg-surface-raised opacity-90 hover:opacity-100",
    card: "border-line bg-surface-panel hover:border-line-strong",
    accent: "text-ink-dim",
    dot: "text-ink-dim",
  },
  AUTO: {
    label: "AUTO",
    // Retired v1 lane: kept only because the Record is keyed by the wire Tier.
    // Never rendered as a lane — see visibleColumns.
    description: "Legacy classification. Shown in QUEUE.",
    plane:
      "tier-plane-auto border-tier-auto/30 bg-gradient-to-b from-tier-auto/[0.05] to-transparent",
    card: "border-tier-auto/15 bg-surface-panel hover:border-tier-auto/40",
    accent: "text-tier-auto-ink",
    dot: "text-tier-auto-ink",
  },
  // Ontology v2 lanes. TIER_V2_ENABLED has been default-on since #1138
  // (2026-08-18); the "dedicated lane design lands with the flip work" that
  // the previous comment here promised did not, so both of these borrowed a
  // neighbour's colour on every surface — MEETING was indistinguishable from
  // PUSH, INFO from SILENT. They own their hue now.
  MEETING: {
    label: "MEETING",
    description: "Scheduling. Accept, decline, or propose — calendar checked.",
    plane:
      "tier-plane-meeting border-tier-meeting/30 bg-gradient-to-b from-tier-meeting/[0.06] to-transparent",
    card: "border-tier-meeting/12 bg-surface-panel hover:border-tier-meeting/40",
    accent: "text-tier-meeting-ink",
    dot: "text-tier-meeting-ink",
  },
  INFO: {
    label: "INFO",
    // Quieter than QUEUE, but NOT silent: INFO is a lane with content you can
    // open, SILENT is suppression. Reusing silent's grey said the opposite.
    description: "Transactional record. Filed — no reply expected.",
    plane:
      "tier-plane-info border-tier-info/20 bg-gradient-to-b from-tier-info/[0.04] to-transparent",
    card: "border-tier-info/10 bg-surface-panel hover:border-tier-info/30",
    accent: "text-tier-info-ink",
    dot: "text-tier-info-ink",
  },
};

// Per-target tint for the override pills, so "Move → PUSH" hints its tier hue.
const TARGET_BUTTON: Record<Tier, string> = {
  PUSH: "hover:border-tier-push/50 hover:text-tier-push-ink",
  QUEUE: "hover:border-tier-queue/50 hover:text-tier-queue-ink",
  SILENT: "hover:border-line-strong hover:text-ink-muted",
  AUTO: "hover:border-tier-auto/50 hover:text-tier-auto-ink",
  MEETING: "hover:border-tier-meeting/50 hover:text-tier-meeting-ink",
  INFO: "hover:border-tier-info/50 hover:text-tier-info-ink",
};

// lane-subset: v1 board targets. MEETING/INFO are absent on purpose — see
// OVERRIDE_TARGETS_V2 directly below.
const OVERRIDE_TARGETS: Tier[] = ["SILENT", "QUEUE", "PUSH"];
/// v2-mode targets: MEETING/INFO become movable once the server actually
/// emits those lanes; showing them to a v1 board would offer moves the
/// server rejects (OVERRIDABLE_TIERS).
const OVERRIDE_TARGETS_V2: Tier[] = ["SILENT", "INFO", "QUEUE", "MEETING", "PUSH"];

export function FirewallBoard() {
  const { toast } = useToast();
  const [data, setData] = useState<FirewallResponse | null>(null);
  const [receipt, setReceipt] = useState<DailyReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [overriding, setOverriding] = useState<string | null>(null);
  // Screen-reader announcement for tier moves — the board mutates silently
  // otherwise (WCAG 4.1.3). Rendered into a polite live region below.
  const [announcement, setAnnouncement] = useState("");

  const load = useCallback(async () => {
    try {
      const [firewall, today] = await Promise.all([
        apiFetch<FirewallResponse>("/api/inbox/firewall/"),
        apiFetch<DailyReceipt>("/api/inbox/receipt/today").catch(() => null),
      ]);
      setData(firewall);
      setReceipt(today);
    } catch (err) {
      captureClientError(err, { scope: "firewall.load" });
      toast("Could not load firewall queue.", "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh so newly-classified mail appears without a manual reload.
  // The mail page already refetches (react-query); this page hand-rolls its
  // fetch, so it stayed stale after a sync. Poll while visible + refetch on
  // focus, but never while an optimistic override is mid-flight (that local
  // state would get clobbered by a server response that predates the move).
  const overridingRef = useRef(overriding);
  overridingRef.current = overriding;
  useEffect(() => {
    const refresh = () => {
      if (overridingRef.current) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      load();
    };
    const intervalId = window.setInterval(refresh, FIREWALL_REFRESH_MS);
    window.addEventListener("focus", refresh);
    // Realtime wake: NotificationBell bridges the WS "conversations-updated"
    // message to this window event. Every other mail surface listened; the
    // flagship board alone sat on its 45s poll (realtime audit 2026-08-18).
    // Same overriding/visibility guards as the poll, via refresh().
    window.addEventListener("conversations-updated", refresh);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("conversations-updated", refresh);
    };
  }, [load]);

  const override = async (item: FirewallItem, newTier: Tier) => {
    if (overriding) return;
    setOverriding(item.id);
    // Optimistic: pull from current tier, push into new tier in local state
    setData((prev) => moveItemBetweenTiers(prev, item, newTier));
    try {
      await apiFetch(`/api/inbox/firewall/${item.id}`, {
        method: "POST",
        body: JSON.stringify({ tier: newTier }),
      });
      setAnnouncement(`Moved “${item.title}” from ${item.tier} to ${newTier}.`);
    } catch (err) {
      // Roll back
      setData((prev) => moveItemBetweenTiers(prev, { ...item, tier: newTier }, item.tier));
      captureClientError(err, { scope: "firewall.override" });
      toast("Could not save tier override.", "error");
    } finally {
      setOverriding(null);
    }
  };

  // Visible columns: PUSH, (MEETING), QUEUE, SILENT. AUTO is a retired v1
  // lane and is never rendered: the API folds it into QUEUE on read, and any
  // AUTO row an older API still sends joins the QUEUE column here rather
  // than vanishing (docs/product-vocabulary.md, "Legacy values").
  const visibleColumns = useMemo(() => {
    if (!data) return null;
    return {
      PUSH: data.tiers.PUSH,
      MEETING: data.tiers.MEETING ?? [],
      QUEUE: [...data.tiers.QUEUE, ...(data.tiers.AUTO ?? [])],
      SILENT: data.tiers.SILENT,
    } as Record<ColumnTier, FirewallItem[]>;
  }, [data]);

  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center px-4 py-10 text-ink-dim">
        Loading firewall…
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex min-h-full items-center justify-center px-4 py-10 text-ink-dim">
        Nothing to show yet.
      </div>
    );
  }

  return (
    <div className="min-h-full px-4 pb-28 pt-6 md:py-10">
      <div className="mx-auto max-w-6xl">
        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
        <header className="mb-8">
          <h1 className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-ink">
            Today's attention firewall
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-ink-mid">
            Klorn evaluated every signal that hit your inbox today and sorted it into a tier. Move
            anything we got wrong — that override teaches the classifier.
          </p>
        </header>

        <DailyReceiptStrip data={data} receipt={receipt} />

        {/* Ontology v2: MEETING becomes a real column only when the server
            emits it (TIER_V2_ENABLED) — a flag-off board is pixel-identical.
            INFO is a records lane, so it renders as a strip below the columns. */}
        <div
          className={`mt-8 grid gap-4 ${
            (data.summary.MEETING ?? 0) > 0 ? "md:grid-cols-4" : "md:grid-cols-3"
          }`}
        >
          {/* lane-subset: columns only. INFO renders as a strip below, and the
              MEETING column appears only once the server has emitted one. */}
          {((data.summary.MEETING ?? 0) > 0
            ? (["PUSH", "MEETING", "QUEUE", "SILENT"] as const)
            : (["PUSH", "QUEUE", "SILENT"] as const)
          ).map((tier) => (
            <TierColumn
              key={tier}
              tier={tier}
              items={visibleColumns?.[tier] ?? []}
              overrideId={overriding}
              onOverride={override}
              v2={(data.summary.MEETING ?? 0) > 0 || (data.summary.INFO ?? 0) > 0}
            />
          ))}
        </div>

        {(data.summary.INFO ?? 0) > 0 && (
          <InfoStrip count={data.summary.INFO} items={data.tiers.INFO} />
        )}
      </div>
    </div>
  );
}

function moveItemBetweenTiers(
  prev: FirewallResponse | null,
  item: FirewallItem,
  newTier: Tier,
): FirewallResponse | null {
  if (!prev) return prev;
  const next = {
    ...prev,
    // summary is a SIBLING of tiers — the old spread nested a summary key
    // inside tiers, which the key-driven copy below would then try to spread
    // as an array on the next optimistic move (second-override crash).
    tiers: { ...prev.tiers },
    summary: { ...prev.summary },
  } as FirewallResponse;
  // Copy each tier array so we mutate a fresh structure
  for (const t of Object.keys(next.tiers) as Tier[]) {
    next.tiers[t] = [...next.tiers[t]];
  }
  next.tiers[item.tier] = next.tiers[item.tier].filter((row) => row.id !== item.id);
  next.tiers[newTier] = [{ ...item, tier: newTier }, ...next.tiers[newTier]];
  next.summary = {
    ...(Object.fromEntries(
      (Object.keys(next.tiers) as Tier[]).map((t) => [t, next.tiers[t].length]),
    ) as Record<Tier, number>),
    total: prev.summary.total,
  };
  return next;
}

// Small SVG glyph per tier — a fast pre-literacy read of "where am I looking".
function TierGlyph({ tier, className }: { tier: Tier; className?: string }) {
  if (tier === "PUSH") {
    // Filled alert diamond.
    return (
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        className={className}
        fill="currentColor"
      >
        <path d="M8 1l7 7-7 7-7-7 7-7z" />
      </svg>
    );
  }
  if (tier === "QUEUE") {
    // Stacked layers — a holding queue.
    return (
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        className={className}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M2 5l6-3 6 3-6 3-6-3z" />
        <path d="M2 8.5l6 3 6-3" />
        <path d="M2 11.5l6 3 6-3" opacity="0.5" />
      </svg>
    );
  }
  if (tier === "AUTO") {
    // Check — done without asking.
    return (
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        className={className}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path d="M3 8.5l3.5 3.5L13 4.5" />
      </svg>
    );
  }
  // SILENT — hollow muted ring.
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="8" cy="8" r="5.5" />
    </svg>
  );
}

// Count that pops once when its value changes (e.g. after an override).
function CountChip({ value, className }: { value: number; className?: string }) {
  const prev = useRef(value);
  const [pop, setPop] = useState(false);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setPop(true);
      const t = window.setTimeout(() => setPop(false), 340);
      return () => window.clearTimeout(t);
    }
  }, [value]);
  return (
    <span
      className={`inline-block tabular-nums ${pop ? "animate-count-pop" : ""} ${className ?? ""}`}
    >
      {value}
    </span>
  );
}

function DailyReceiptStrip({
  data,
  receipt,
}: {
  data: FirewallResponse;
  receipt: DailyReceipt | null;
}) {
  const counts = CORE_TIERS;
  return (
    <section className="panel-elevated rounded-2xl border border-line/70 bg-surface-panel p-5">
      {/* Five columns, not four: the strip used to count PUSH/QUEUE/SILENT/AUTO
          — a lane that no longer occurs — while omitting MEETING and INFO. */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
        {counts.map((tier) => {
          const v = TIER_VISUAL[tier];
          return (
            <div key={tier} className="flex items-center gap-3">
              <TierGlyph tier={tier} className={v.dot} />
              <div className="flex flex-col">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-dim">
                  {v.label}
                </span>
                <CountChip
                  value={data.summary[tier]}
                  className={`text-2xl font-semibold leading-none ${v.accent}`}
                />
              </div>
            </div>
          );
        })}
      </div>
      {receipt?.summary?.narrative && (
        <p className="mt-4 border-t border-line pt-4 text-xs leading-5 text-ink-dim">
          {receipt.summary.narrative}
        </p>
      )}
    </section>
  );
}

function TierColumn({
  tier,
  items,
  overrideId,
  onOverride,
  v2,
}: {
  tier: ColumnTier;
  items: FirewallItem[];
  overrideId: string | null;
  onOverride: (item: FirewallItem, newTier: Tier) => void;
  v2: boolean;
}) {
  const v = TIER_VISUAL[tier];
  return (
    <section className={`glass rounded-2xl border p-4 transition-opacity ${v.plane}`}>
      <header className="mb-1 flex items-center gap-2">
        <TierGlyph tier={tier} className={v.dot} />
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-ink">
          {v.label}
        </h2>
        <CountChip value={items.length} className={`ml-auto text-sm font-semibold ${v.accent}`} />
      </header>
      <p className="mb-4 text-[11px] leading-5 text-ink-dim">{v.description}</p>

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-8 text-center text-xs text-ink-mid">
          Nothing here yet.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {items.map((item, i) => (
            <FirewallCard
              key={item.id}
              item={item}
              tier={tier}
              index={i}
              overrideId={overrideId}
              onOverride={onOverride}
              v2={v2}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function FirewallCard({
  item,
  tier,
  index,
  overrideId,
  onOverride,
  v2,
}: {
  item: FirewallItem;
  tier: ColumnTier;
  index: number;
  overrideId: string | null;
  onOverride: (item: FirewallItem, newTier: Tier) => void;
  v2: boolean;
}) {
  const v = TIER_VISUAL[tier];
  // Best-effort meaningful heading: actual email subject beats the
  // tool-arg subject beats the agent's auto-title fallback.
  const subject = item.email?.subject || toolSubject(item) || item.title;
  const sender = item.email?.from || toolRecipient(item);
  const snippet = item.email?.snippet || toolBodyPreview(item);
  // opacity marks the ONE card being moved; the buttons disable while ANY
  // override is in flight, because override() has a single-flight guard
  // (`if (overriding) return`) — without this, other cards' buttons look
  // clickable but silently no-op mid-override.
  const busy = overrideId === item.id;
  const anyOverriding = overrideId !== null;

  return (
    <li
      className={`lift animate-card-in rounded-xl border p-3.5 text-sm ${v.card} ${
        busy ? "opacity-50" : ""
      }`}
      // Stagger only the first screenful so a fresh load cascades in; later
      // cards (and re-renders) appear immediately.
      style={index < 8 ? { animationDelay: `${index * 35}ms` } : undefined}
    >
      <p className="line-clamp-2 break-words font-medium text-ink">{subject}</p>
      {sender && (
        <p className="mt-1 flex items-center gap-1.5 truncate text-[11px] text-ink-dim">
          {item.email?.trust && <TrustDot trust={item.email.trust} />}
          <span className="truncate">
            {item.email?.from ? "From" : "To"}: {sender}
          </span>
        </p>
      )}
      <div className="mt-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-ink-mid">
        <SourceBadge source={item.source} />
        {item.toolName && (
          <>
            <span>·</span>
            <span>{item.toolName.replace(/_/g, " ")}</span>
          </>
        )}
        <span>·</span>
        <span>{relativeTime(item.surfacedAt)}</span>
      </div>

      {snippet && (
        <details className="group mt-2.5 rounded-lg border border-line bg-surface-raised">
          <summary className="flex cursor-pointer list-none items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] text-ink-mid transition hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <span aria-hidden="true" className="inline-block transition group-open:rotate-90">
              ›
            </span>
            <span className="group-open:hidden">Show preview</span>
            <span className="hidden group-open:inline">Hide preview</span>
          </summary>
          <p className="line-clamp-6 whitespace-pre-wrap border-t border-line px-2.5 py-2 text-[11px] leading-4 text-ink-mid">
            {snippet}
          </p>
        </details>
      )}

      {item.tierReason && (
        <p className="mt-2.5 line-clamp-2 border-l-2 border-line pl-2 text-[11px] leading-4 text-ink-dim">
          {item.tierReason}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {(v2 ? OVERRIDE_TARGETS_V2 : OVERRIDE_TARGETS)
          .filter((t) => t !== tier)
          .map((target) => (
            <button
              key={target}
              type="button"
              disabled={anyOverriding}
              onClick={() => onOverride(item, target)}
              className={`ease-strong inline-flex min-h-7 items-center rounded-full border border-line bg-surface-panel/70 px-2.5 text-[10px] font-medium uppercase tracking-wider text-ink-mid transition duration-150 hover:bg-surface-panel active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 ${TARGET_BUTTON[target]}`}
            >
              Move → {target}
            </button>
          ))}
        {item.href && (
          <Link
            href={item.href}
            className={`ml-auto text-[11px] transition ${v.accent} hover:text-ink`}
          >
            Open email →
          </Link>
        )}
      </div>
    </li>
  );
}

function pickString(
  args: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function toolSubject(item: FirewallItem): string | undefined {
  if (!item.toolArgs || !item.toolName) return undefined;
  if (item.toolName === "send_email" || item.toolName === "reply_to_email") {
    return pickString(item.toolArgs, "subject");
  }
  if (item.toolName === "create_event") {
    return pickString(item.toolArgs, "title", "summary");
  }
  return undefined;
}

function toolRecipient(item: FirewallItem): string | undefined {
  if (!item.toolArgs || !item.toolName) return undefined;
  if (item.toolName === "send_email" || item.toolName === "reply_to_email") {
    return pickString(item.toolArgs, "to", "recipient");
  }
  return undefined;
}

function toolBodyPreview(item: FirewallItem): string | undefined {
  if (!item.toolArgs || !item.toolName) return undefined;
  if (item.toolName === "send_email" || item.toolName === "reply_to_email") {
    return pickString(item.toolArgs, "body");
  }
  if (item.toolName === "create_event") {
    const start = pickString(item.toolArgs, "start_time", "startTime");
    const loc = pickString(item.toolArgs, "location");
    const parts: string[] = [];
    if (start) parts.push(`Starts: ${start}`);
    if (loc) parts.push(`Location: ${loc}`);
    return parts.length ? parts.join("\n") : undefined;
  }
  return undefined;
}

/** Records lane (ontology v2): filed transactional mail — visible, never a
 * column (nothing here ever needs a reply). */
function InfoStrip({ count, items }: { count: number; items: FirewallItem[] }) {
  const v = TIER_VISUAL.INFO;
  return (
    <section className={`glass mt-4 rounded-2xl border p-4 ${v.plane}`}>
      <header className="flex items-center gap-2">
        <TierGlyph tier="INFO" className={v.dot} />
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-dim">
          INFO
        </h2>
        <CountChip value={count} className={`ml-auto text-sm font-semibold ${v.accent}`} />
      </header>
      <p className="mt-1.5 text-[11px] leading-5 text-ink-dim">{v.description}</p>
      <ul className="mt-3 space-y-1.5 text-xs text-ink-mid">
        {items.slice(0, 5).map((item) => (
          <li key={item.id} className="flex items-center gap-2 line-clamp-1">
            <span className="text-ink-dim/60">·</span>
            <span className="truncate">{item.title}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SourceBadge({ source }: { source: string }) {
  return <span className="font-mono text-[10px] text-ink-dim">{source}</span>;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
